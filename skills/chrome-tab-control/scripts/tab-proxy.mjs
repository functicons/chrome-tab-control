#!/usr/bin/env node
// Tab Control — tab proxy (native messaging host)
// Bridges Chrome extension ↔ a Unix socket for CLI/agent access.
// Launched by Chrome via native messaging when the extension connects.
//
// Protocol:
//   Extension ↔ Host: Chrome native messaging (4-byte LE length + JSON on stdin/stdout)
//   CLI ↔ Host: NDJSON over a Unix socket (~/.chrome-tab-control/sock/proxy-<pid>.sock)
//
// Access control: shared tabs are never listed. The extension gives each shared
// tab a random, secret tab handle; a client attaches to a tab by sending its
// handle (ATTACH_METHOD) and only then can it send CDP commands or receive
// events for that tab. The host forwards commands to the extension, which
// executes them via chrome.debugger.sendCommand(). The socket directory is
// private (0700).

import net from 'net';
import { createHash, timingSafeEqual } from 'crypto';
import { unlinkSync, chmodSync, mkdirSync, lstatSync, readdirSync } from 'fs';
import { resolve } from 'path';
import {
  configDir, sockDir, proxySocketPath, PROXY_SOCKET_RE,
  PRIVATE_DIR_MODE, ATTACH_METHOD, AttachError, normalizeTabHandle,
} from './protocol.mjs';

const CDP_TIMEOUT = 15000;
const SOCKET_PATH = proxySocketPath(process.pid);

// State
const sharedTabs = new Map();   // tabId -> {url, title, handle}
const clients = new Map();      // conn -> {tabId: number | null}
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
// Startup: private socket directory
// ---------------------------------------------------------------------------

// Creates dir with 0700 and refuses to use it unless it is a real directory
// owned by this user, so no other account can plant or reach our socket.
function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is not owned by the current user`);
  chmodSync(dir, PRIVATE_DIR_MODE);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Sockets of proxies that died without cleanup (e.g. SIGKILL) would make every
// CLI call try a dead endpoint, so remove them.
function removeStaleSockets() {
  for (const name of readdirSync(sockDir())) {
    const pid = Number(name.match(PROXY_SOCKET_RE)?.[1]);
    if (pid && pid !== process.pid && !isProcessAlive(pid)) {
      try { unlinkSync(resolve(sockDir(), name)); } catch {}
    }
  }
}

try {
  ensurePrivateDir(configDir());
  ensurePrivateDir(sockDir());
  removeStaleSockets();
} catch (e) {
  log(`Refusing to start: ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeLine(conn, msg) {
  conn.write(JSON.stringify(msg) + '\n');
}

// Hashing first gives equal-length buffers, as timingSafeEqual requires.
function handleMatches(given, expected) {
  const digest = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

// Checks every tab (no early exit) so timing does not reveal which tab matched.
function findTabByHandle(handle) {
  const given = normalizeTabHandle(handle);
  let found = null;
  for (const [tabId, tab] of sharedTabs) {
    if (handleMatches(given, tab.handle) && found === null) found = tabId;
  }
  return found;
}

function clientsOf(tabId) {
  return [...clients].filter(([, c]) => c.tabId === tabId).map(([conn]) => conn);
}

function disconnectClientsOf(tabId) {
  for (const conn of clientsOf(tabId)) {
    writeLine(conn, { event: '_tab_unshared' });
    conn.end();
  }
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

function onTabShared({ tabId, url, title, handle }) {
  if (!handle) {
    log(`Ignoring share of tab ${tabId}: no tab handle`);
    return;
  }
  const normalized = normalizeTabHandle(handle);
  // Re-shared under a new handle: sessions attached with the old one end.
  if (sharedTabs.get(tabId)?.handle !== normalized) disconnectClientsOf(tabId);
  sharedTabs.set(tabId, { url, title, handle: normalized });
  log(`Tab shared: ${tabId} — ${url}`);
}

function onTabUnshared({ tabId }) {
  if (!sharedTabs.delete(tabId)) return;
  disconnectClientsOf(tabId);
  log(`Tab unshared: ${tabId}`);
}

function onTabUpdated({ tabId, url, title }) {
  const tab = sharedTabs.get(tabId);
  if (!tab) return;
  if (url) tab.url = url;
  if (title) tab.title = title;
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
  for (const conn of clientsOf(tabId)) {
    try { writeLine(conn, { event: method, params }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// CLI socket
// ---------------------------------------------------------------------------

// Replies with an error and closes, so a rejected client cannot keep guessing
// on the same connection.
function rejectClient(conn, id, error) {
  writeLine(conn, { id, ok: false, error });
  conn.end();
}

function handleAttach(client, id, params, conn) {
  const tabId = findTabByHandle(params?.handle);
  if (tabId === null) {
    log('Attach rejected: unknown tab handle');
    return rejectClient(conn, id, AttachError.UNKNOWN);
  }
  client.tabId = tabId;
  const { url, title } = sharedTabs.get(tabId);
  writeLine(conn, { id, ok: true, result: { tabId, url, title } });
}

async function handleCliRequest(req, conn) {
  const { id, method, params } = req;
  const client = clients.get(conn);
  if (!client) return;

  if (method === ATTACH_METHOD) return handleAttach(client, id, params, conn);
  if (client.tabId === null || !sharedTabs.has(client.tabId)) {
    return rejectClient(conn, id, AttachError.REQUIRED);
  }

  if (!method) {
    writeLine(conn, { id, ok: false, error: 'Missing "method" field' });
    return;
  }

  try {
    const result = await sendCdpCommand(client.tabId, method, params || {});
    writeLine(conn, { id, ok: true, result });
  } catch (e) {
    writeLine(conn, { id, ok: false, error: e.message });
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

const server = net.createServer((conn) => {
  clients.set(conn, { tabId: null });
  let buf = '';

  conn.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (conn.writableEnded) return; // rejected earlier in this chunk
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); } catch {
        writeLine(conn, { id: null, ok: false, error: 'Invalid JSON' });
        continue;
      }
      handleCliRequest(req, conn);
    }
  });

  conn.on('error', () => {});
  conn.on('close', () => { clients.delete(conn); });
});

try { unlinkSync(SOCKET_PATH); } catch {}
server.listen(SOCKET_PATH, () => {
  try { chmodSync(SOCKET_PATH, 0o600); } catch {}
});

function cleanup() {
  for (const conn of clients.keys()) { try { conn.end(); } catch {} }
  server.close();
  try { unlinkSync(SOCKET_PATH); } catch {}
  log('Cleaned up');
}

log('Tab proxy started');
