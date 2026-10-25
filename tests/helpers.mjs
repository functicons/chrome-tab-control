// Shared harness for tests that run the real tab proxy: a fake extension that
// speaks native messaging to it, an NDJSON socket client, and a CLI runner,
// all against a temp HOME. No browser needed.

import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/chrome-tab-control/scripts');
export const PROXY = resolve(SCRIPTS, 'tab-proxy.mjs');
export const CLI = resolve(SCRIPTS, 'tab-control-cli.mjs');
const { ATTACH_METHOD } = await import(resolve(SCRIPTS, 'protocol.mjs'));

export const TAB = { tabId: 42, url: 'https://example.com/', title: 'Example', handle: 'Q3MW-8HZD-T6PN' };
export const OTHER_TAB = { tabId: 7, url: 'https://other.test/', title: 'Other', handle: 'ZZZZ-YYYY-XXXX' };
export const WAIT_MS = 3000;
export const POLL_MS = 20;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function until(pred, what) {
  const deadline = Date.now() + WAIT_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

// Fake extension: spawns a proxy, speaks native messaging to it, answers every
// cdp_command, and records everything the proxy sends.
export class FakeExtension {
  constructor(home, env = {}) {
    this.home = home;
    this.received = [];
    this.stderr = '';
    this.proc = spawn(process.execPath, [PROXY], {
      env: { ...process.env, HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stderr.on('data', (chunk) => { this.stderr += chunk; });
    let buf = Buffer.alloc(0);
    this.proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        this.#onMessage(JSON.parse(buf.subarray(4, 4 + len).toString()));
        buf = buf.subarray(4 + len);
      }
    });
  }

  get socketPath() {
    return `${this.home}/.chrome-tab-control/sock/proxy-${this.proc.pid}.sock`;
  }

  #onMessage(msg) {
    this.received.push(msg);
    if (msg.type === 'cdp_command') {
      this.send({ type: 'cdp_response', requestId: msg.requestId, result: cdpResult(msg) });
    }
  }

  send(msg) {
    const json = Buffer.from(JSON.stringify(msg));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length, 0);
    this.proc.stdin.write(Buffer.concat([len, json]));
  }

  // Sends a tab change and waits until the proxy logged applying it, so a
  // following connect cannot race ahead of it.
  async apply(msg, logPattern) {
    const before = (this.stderr.match(logPattern) || []).length;
    this.send(msg);
    await until(() => (this.stderr.match(logPattern) || []).length > before, `proxy to apply ${msg.type}`);
  }

  share(tab) {
    return this.apply({ type: 'tab_shared', ...tab }, /Tab shared/g);
  }

  unshare(tabId) {
    return this.apply({ type: 'tab_unshared', tabId }, /Tab unshared/g);
  }

  cdpCommands() {
    return this.received.filter((m) => m.type === 'cdp_command');
  }

  async stop() {
    this.proc.stdin.end();
    // A killed proc has signalCode set and exitCode null, and 'exit' already fired.
    if (this.proc.exitCode === null && this.proc.signalCode === null) await once(this.proc, 'exit');
  }
}

function cdpResult(msg) {
  if (msg.method === 'Runtime.evaluate') {
    return { result: { value: `tab ${msg.tabId} evaluated ${msg.params.expression}` } };
  }
  return { echo: msg.method, tabId: msg.tabId };
}

// Minimal NDJSON socket client mirroring what the CLI sends.
export class Client {
  static async connect(path) {
    const c = new Client(net.connect(path));
    await withTimeout(once(c.conn, 'connect'), 'socket connect');
    return c;
  }

  constructor(conn) {
    this.conn = conn;
    this.lines = [];
    this.nextId = 0;
    this.closed = once(conn, 'close');
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const p of parts.filter(Boolean)) this.lines.push(JSON.parse(p));
    });
    conn.on('error', () => {});
  }

  async request(method, params = {}) {
    const id = ++this.nextId;
    this.conn.write(JSON.stringify({ id, method, params }) + '\n');
    await until(() => this.lines.some((m) => m.id === id), `reply to ${method}`);
    return this.lines.find((m) => m.id === id);
  }

  // extra: e.g. {remote: '<host>'}, as the remote link's bridge sends it.
  attach(handle, extra = {}) {
    return this.request(ATTACH_METHOD, { handle, ...extra });
  }

  events(name) {
    return this.lines.filter((m) => m.event === name);
  }

  close() {
    this.conn.destroy();
  }
}

// /tmp keeps socket paths under the ~104-byte macOS sun_path limit.
export const makeHome = () => mkdtempSync('/tmp/tc-test-');

export async function startProxy(home, env = {}) {
  const ext = new FakeExtension(home, env);
  await until(() => ext.stderr.includes('Tab proxy started') || ext.proc.exitCode !== null, 'proxy start');
  await until(() => { try { statSync(ext.socketPath); return true; } catch { return false; } }, 'proxy socket');
  return ext;
}

// Spawns a proxy sharing the given tabs, runs fn, cleans up.
export async function withProxy(tabs, fn) {
  const home = makeHome();
  const ext = await startProxy(home);
  try {
    for (const tab of tabs) await ext.share(tab);
    await fn({ ext, home, connect: () => Client.connect(ext.socketPath) });
  } finally {
    await ext.stop();
    rmSync(home, { recursive: true, force: true });
  }
}

// timeoutMs kills a CLI that should have exited but did not (e.g. a remote link).
export const runCli = (home, args, env = {}, timeoutMs = 0) => promisify(execFile)(process.execPath, [CLI, ...args], {
  env: { ...process.env, HOME: home, ...env },
  timeout: timeoutMs,
}).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
