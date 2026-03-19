#!/usr/bin/env node
// Tab Control — tab proxy (native messaging host)
// Bridges Chrome extension ↔ Unix sockets for CLI/agent access.
// Launched by Chrome via native messaging when the extension connects.
//
// Protocol:
//   Extension ↔ Host: Chrome native messaging (4-byte LE length + JSON on stdin/stdout)
//   CLI ↔ Host: NDJSON over Unix sockets (/tmp/chrome-tab-control/tab-<tabId>.sock)
//
// The host creates one Unix socket per shared tab. CLI clients connect to
// these sockets and send raw CDP commands. The host forwards them to the
// extension, which executes them via chrome.debugger.sendCommand().

import net from 'net';
import { writeFileSync, unlinkSync, chmodSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

const CONFIG_DIR = resolve(homedir(), '.chrome-tab-control');
const SHARED_TABS_FILE = resolve(CONFIG_DIR, 'shared-tabs.json');
const SOCK_DIR = '/tmp/chrome-tab-control';
const SOCK_PREFIX = `${SOCK_DIR}/tab-`;
const CDP_TIMEOUT = 15000;

try { mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
try { mkdirSync(SOCK_DIR, { recursive: true }); } catch {}

// State
const sharedTabs = new Map();   // tabId -> {url, title, server, socketPath, connections: Set}
const pendingRequests = new Map(); // requestId -> {resolve, reject, timer}
let requestCounter = 0;

// ---------------------------------------------------------------------------
// Native messaging I/O (stdin/stdout, 4-byte LE length prefix)
// ---------------------------------------------------------------------------

function sendToExtension(msg) {
  const json = JSON.stringify(msg);
  const len = Buffer.byteLength(json);
  const buf = Buffer.alloc(4 + len);
  buf.writeUInt32LE(len, 0);
  buf.write(json, 4);
  process.stdout.write(buf);
}

let inputBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inputBuf = Buffer.concat([inputBuf, chunk]);
  while (inputBuf.length >= 4) {
    const msgLen = inputBuf.readUInt32LE(0);
    if (inputBuf.length < 4 + msgLen) break;
    const json = inputBuf.subarray(4, 4 + msgLen).toString();
    inputBuf = inputBuf.subarray(4 + msgLen);
    try {
      handleExtensionMessage(JSON.parse(json));
    } catch (e) {
      log(`Parse error: ${e.message}`);
    }
  }
});

process.stdin.on('end', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });

function log(msg) {
  process.stderr.write(`[tab-proxy] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Extension message handlers
// ---------------------------------------------------------------------------

function handleExtensionMessage(msg) {
  switch (msg.type) {
    case 'tab_shared':   onTabShared(msg); break;
    case 'tab_unshared': onTabUnshared(msg); break;
    case 'tab_updated':  onTabUpdated(msg); break;
    case 'cdp_response': onCdpResponse(msg); break;
    case 'cdp_error':    onCdpError(msg); break;
    case 'cdp_event':    onCdpEvent(msg); break;
    default:             log(`Unknown message type: ${msg.type}`);
  }
}

function onTabShared({ tabId, url, title }) {
  if (sharedTabs.has(tabId)) return; // already shared

  const socketPath = `${SOCK_PREFIX}${tabId}.sock`;
  try { unlinkSync(socketPath); } catch {}

  const connections = new Set();
  const server = net.createServer((conn) => {
    connections.add(conn);
    let buf = '';

    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch {
          conn.write(JSON.stringify({ id: null, ok: false, error: 'Invalid JSON' }) + '\n');
          continue;
        }
        handleCliRequest(tabId, req, conn);
      }
    });

    conn.on('error', () => {});
    conn.on('close', () => { connections.delete(conn); });
  });

  server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600); } catch {}
  });

  sharedTabs.set(tabId, { url, title, server, socketPath, connections });
  writeSharedTabsFile();
  log(`Tab shared: ${tabId} — ${url}`);
}

function onTabUnshared({ tabId }) {
  const tab = sharedTabs.get(tabId);
  if (!tab) return;

  for (const conn of tab.connections) {
    conn.write(JSON.stringify({ event: '_tab_unshared' }) + '\n');
    conn.end();
  }
  tab.server.close();
  try { unlinkSync(tab.socketPath); } catch {}
  sharedTabs.delete(tabId);
  writeSharedTabsFile();
  log(`Tab unshared: ${tabId}`);
}

function onTabUpdated({ tabId, url, title }) {
  const tab = sharedTabs.get(tabId);
  if (!tab) return;
  if (url) tab.url = url;
  if (title) tab.title = title;
  writeSharedTabsFile();
}

function onCdpResponse({ requestId, result }) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(result);
}

function onCdpError({ requestId, error }) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.reject(new Error(error));
}

function onCdpEvent({ tabId, method, params }) {
  const tab = sharedTabs.get(tabId);
  if (!tab) return;
  const msg = JSON.stringify({ event: method, params }) + '\n';
  for (const conn of tab.connections) {
    try { conn.write(msg); } catch {}
  }
}

// ---------------------------------------------------------------------------
// CLI request handling
// ---------------------------------------------------------------------------

async function handleCliRequest(tabId, req, conn) {
  const { id, method, params } = req;

  if (!method) {
    conn.write(JSON.stringify({ id, ok: false, error: 'Missing "method" field' }) + '\n');
    return;
  }

  try {
    const result = await sendCdpCommand(tabId, method, params || {});
    conn.write(JSON.stringify({ id, ok: true, result }) + '\n');
  } catch (e) {
    conn.write(JSON.stringify({ id, ok: false, error: e.message }) + '\n');
  }
}

function sendCdpCommand(tabId, method, params, timeout = CDP_TIMEOUT) {
  const requestId = String(++requestCounter);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Timeout: ${method}`));
    }, timeout);
    pendingRequests.set(requestId, { resolve, reject, timer });
    sendToExtension({ type: 'cdp_command', requestId, tabId, method, params });
  });
}

// ---------------------------------------------------------------------------
// Shared tabs file
// ---------------------------------------------------------------------------

function writeSharedTabsFile() {
  const tabs = [];
  for (const [tabId, info] of sharedTabs) {
    tabs.push({ tabId, url: info.url, title: info.title, socketPath: info.socketPath });
  }
  try {
    writeFileSync(SHARED_TABS_FILE, JSON.stringify(tabs, null, 2));
  } catch (e) {
    log(`Failed to write shared tabs file: ${e.message}`);
  }
}

function cleanup() {
  for (const [tabId, tab] of sharedTabs) {
    for (const conn of tab.connections) { try { conn.end(); } catch {} }
    tab.server.close();
    try { unlinkSync(tab.socketPath); } catch {}
  }
  sharedTabs.clear();
  // Write empty file so CLI knows no tabs are shared
  try { writeFileSync(SHARED_TABS_FILE, '[]'); } catch {}
  log('Cleaned up');
}

log('Tab proxy started');
