// Integration tests for tab-proxy.mjs access control: the private socket
// directory, and reaching a shared tab only through its secret tab handle.
//
// Each test spawns the real proxy with HOME pointed at a temp dir, plays the
// extension over native messaging (stdin/stdout), and connects as a CLI client
// over the proxy's Unix socket. No browser needed.
//
// Run: make test   (or: node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readdirSync, mkdirSync, symlinkSync, closeSync, openSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/chrome-tab-control/scripts');
const PROXY = resolve(SCRIPTS, 'tab-proxy.mjs');
const CLI = resolve(SCRIPTS, 'tab-control-cli.mjs');
const { ATTACH_METHOD, AttachError } = await import(resolve(SCRIPTS, 'protocol.mjs'));

const TAB = { tabId: 42, url: 'https://example.com/', title: 'Example', handle: 'Q3MW-8HZD-T6PN' };
const OTHER_TAB = { tabId: 7, url: 'https://other.test/', title: 'Other', handle: 'ZZZZ-YYYY-XXXX' };
const WAIT_MS = 3000;
const POLL_MS = 20;

// --- harness ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function until(pred, what) {
  const deadline = Date.now() + WAIT_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

// Fake extension: spawns a proxy, speaks native messaging to it, answers every
// cdp_command, and records everything the proxy sends.
class FakeExtension {
  constructor(home) {
    this.home = home;
    this.received = [];
    this.stderr = '';
    this.proc = spawn(process.execPath, [PROXY], {
      env: { ...process.env, HOME: home },
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
    if (this.proc.exitCode === null) await once(this.proc, 'exit');
  }
}

function cdpResult(msg) {
  if (msg.method === 'Runtime.evaluate') {
    return { result: { value: `tab ${msg.tabId} evaluated ${msg.params.expression}` } };
  }
  return { echo: msg.method, tabId: msg.tabId };
}

// Minimal NDJSON socket client mirroring what the CLI sends.
class Client {
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

  attach(handle) {
    return this.request(ATTACH_METHOD, { handle });
  }

  events(name) {
    return this.lines.filter((m) => m.event === name);
  }

  close() {
    this.conn.destroy();
  }
}

// /tmp keeps socket paths under the ~104-byte macOS sun_path limit.
const makeHome = () => mkdtempSync('/tmp/tc-test-');

async function startProxy(home) {
  const ext = new FakeExtension(home);
  await until(() => ext.stderr.includes('Tab proxy started') || ext.proc.exitCode !== null, 'proxy start');
  await until(() => { try { statSync(ext.socketPath); return true; } catch { return false; } }, 'proxy socket');
  return ext;
}

// Spawns a proxy sharing the given tabs, runs fn, cleans up.
async function withProxy(tabs, fn) {
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

const runCli = (home, args) => promisify(execFile)(process.execPath, [CLI, ...args], {
  env: { ...process.env, HOME: home },
}).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

// --- private socket directory ---------------------------------------------

test('proxy socket lives in a 0700 directory under ~/.chrome-tab-control', async () => {
  await withProxy([], async ({ home, ext }) => {
    for (const dir of ['.chrome-tab-control', '.chrome-tab-control/sock']) {
      assert.equal(statSync(`${home}/${dir}`).mode & 0o777, 0o700, dir);
    }
    assert.equal(statSync(ext.socketPath).mode & 0o777, 0o600);
  });
});

test('proxy refuses to start when the socket directory is a symlink', async () => {
  const home = makeHome();
  try {
    mkdirSync(`${home}/.chrome-tab-control`, { mode: 0o700 });
    mkdirSync(`${home}/elsewhere`);
    symlinkSync(`${home}/elsewhere`, `${home}/.chrome-tab-control/sock`);
    const ext = new FakeExtension(home);
    const [code] = await withTimeout(once(ext.proc, 'exit'), 'proxy exit');
    assert.equal(code, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('proxy removes sockets left by dead proxies but keeps live ones', async () => {
  const home = makeHome();
  const sock = `${home}/.chrome-tab-control/sock`;
  const live = await startProxy(home);
  const deadPid = 2 ** 22 + 12345; // above default pid_max, so never a live process
  closeSync(openSync(`${sock}/proxy-${deadPid}.sock`, 'w'));
  const second = await startProxy(home);
  try {
    assert.deepEqual(readdirSync(sock).sort(),
      [`proxy-${live.proc.pid}.sock`, `proxy-${second.proc.pid}.sock`].sort());
  } finally {
    await live.stop();
    await second.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('proxy writes no list of shared tabs to disk', async () => {
  await withProxy([TAB], async ({ home }) => {
    assert.deepEqual(readdirSync(`${home}/.chrome-tab-control`), ['sock']);
  });
});

// --- attaching by tab handle ------------------------------------------------

test('commands before attaching are rejected and never reach the tab', async () => {
  await withProxy([TAB], async ({ connect, ext }) => {
    const c = await connect();
    const reply = await c.request('Runtime.evaluate', { expression: 'document.cookie' });
    assert.equal(reply.error, AttachError.REQUIRED);
    await withTimeout(c.closed, 'server to close the connection');
    assert.equal(ext.cdpCommands().length, 0);
  });
});

test('an unknown tab handle is rejected and the connection closed', async () => {
  await withProxy([TAB], async ({ connect, ext }) => {
    const c = await connect();
    assert.equal((await c.attach('AAAA-BBBB-CCCC')).error, AttachError.UNKNOWN);
    await withTimeout(c.closed, 'server to close the connection');
    assert.equal(ext.cdpCommands().length, 0);
  });
});

test('attaching returns the tab, and commands go to that tab', async () => {
  await withProxy([TAB, OTHER_TAB], async ({ connect }) => {
    const c = await connect();
    const attached = await c.attach(TAB.handle);
    assert.deepEqual(attached.result, { tabId: TAB.tabId, url: TAB.url, title: TAB.title });
    assert.deepEqual((await c.request('Page.enable')).result, { echo: 'Page.enable', tabId: TAB.tabId });

    const o = await connect();
    await o.attach(OTHER_TAB.handle);
    assert.equal((await o.request('Page.enable')).result.tabId, OTHER_TAB.tabId);
    c.close();
    o.close();
  });
});

test('tab handle matching ignores case and surrounding whitespace', async () => {
  await withProxy([TAB], async ({ connect }) => {
    const c = await connect();
    assert.equal((await c.attach(`  ${TAB.handle.toLowerCase()} `)).ok, true);
    c.close();
  });
});

test('CDP events reach only clients attached to that tab', async () => {
  await withProxy([TAB, OTHER_TAB], async ({ connect, ext }) => {
    const mine = await connect();
    await mine.attach(TAB.handle);
    const other = await connect();
    await other.attach(OTHER_TAB.handle);
    const unattached = await connect();

    ext.send({ type: 'cdp_event', tabId: TAB.tabId, method: 'Network.requestWillBeSent', params: {} });
    await until(() => mine.events('Network.requestWillBeSent').length === 1, 'event on attached client');
    // Round-trips on the other sockets so they had their chance to receive it too.
    await other.request('Page.enable');
    assert.equal(other.events('Network.requestWillBeSent').length, 0);
    assert.equal(unattached.events('Network.requestWillBeSent').length, 0);
    [mine, other, unattached].forEach((c) => c.close());
  });
});

test('unsharing disconnects attached clients and retires the handle', async () => {
  await withProxy([TAB], async ({ connect, ext }) => {
    const c = await connect();
    await c.attach(TAB.handle);
    await ext.unshare(TAB.tabId);
    await withTimeout(c.closed, 'server to close the connection');
    assert.equal(c.events('_tab_unshared').length, 1);

    const late = await connect();
    assert.equal((await late.attach(TAB.handle)).error, AttachError.UNKNOWN);
  });
});

test('re-sharing a tab under a new handle disconnects clients of the old one', async () => {
  await withProxy([TAB], async ({ connect, ext }) => {
    const c = await connect();
    await c.attach(TAB.handle);
    await ext.share({ ...TAB, handle: 'NEW0-NEW0-NEW0' });
    await withTimeout(c.closed, 'server to close the connection');

    const stale = await connect();
    assert.equal((await stale.attach(TAB.handle)).error, AttachError.UNKNOWN);
  });
});

// --- CLI end to end ----------------------------------------------------------

test('CLI reaches a tab by its handle', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runCli(home, ['eval', TAB.handle, '1+1']);
    assert.equal(r.stdout.trim(), `tab ${TAB.tabId} evaluated 1+1`, r.stderr);
  });
});

test('CLI info shows the title and URL of the tab', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runCli(home, ['info', TAB.handle]);
    assert.match(r.stdout, /Title: Example/);
    assert.match(r.stdout, /URL: +https:\/\/example\.com\//);
  });
});

test('CLI finds the tab across several proxies (one per Chrome profile)', async () => {
  const home = makeHome();
  const first = await startProxy(home);
  const second = await startProxy(home);
  try {
    await first.share(TAB);
    await second.share(OTHER_TAB);
    const a = await runCli(home, ['eval', TAB.handle, 'a']);
    const b = await runCli(home, ['eval', OTHER_TAB.handle, 'b']);
    assert.equal(a.stdout.trim(), `tab ${TAB.tabId} evaluated a`, a.stderr);
    assert.equal(b.stdout.trim(), `tab ${OTHER_TAB.tabId} evaluated b`, b.stderr);
  } finally {
    await first.stop();
    await second.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI rejects an unknown handle without touching any tab', async () => {
  await withProxy([TAB], async ({ home, ext }) => {
    const r = await runCli(home, ['eval', 'AAAA-BBBB-CCCC', '1+1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No shared tab has the handle/);
    assert.equal(ext.cdpCommands().length, 0);
  });
});

test('CLI rejects something that is not a tab handle, such as a numeric tab id', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runCli(home, ['snap', String(TAB.tabId)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not a tab handle/);
  });
});

test('CLI list is disabled and does not reveal shared tabs', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runCli(home, ['list']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Listing shared tabs is disabled/);
    assert.doesNotMatch(r.stdout + r.stderr, /example\.com|Example|Q3MW/);
  });
});

test('CLI explains when no proxy is running', async () => {
  const home = makeHome();
  try {
    const r = await runCli(home, ['snap', TAB.handle]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Tab Control is not running/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
