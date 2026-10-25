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
import { rmSync, statSync, readdirSync, mkdirSync, symlinkSync, closeSync, openSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import {
  SCRIPTS, TAB, OTHER_TAB, withTimeout, until, FakeExtension, makeHome, startProxy, withProxy, runCli,
} from './helpers.mjs';

const { AttachError } = await import(resolve(SCRIPTS, 'protocol.mjs'));

// --- private socket directory ---------------------------------------------

test('proxy socket lives in a 0700 directory under ~/.chrome-tab-control', async () => {
  await withProxy([], async ({ home, ext }) => {
    for (const dir of ['.chrome-tab-control', '.chrome-tab-control/sock']) {
      assert.equal(statSync(`${home}/${dir}`).mode & 0o777, 0o700, dir);
    }
    // The proxy chmods the socket in its listen callback, just after the file appears.
    await until(() => (statSync(ext.socketPath).mode & 0o777) === 0o600, 'socket mode 0600');
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

test('a connection attached to one tab cannot attach to another', async () => {
  await withProxy([TAB, OTHER_TAB], async ({ ext, connect }) => {
    const c = await connect();
    assert.equal((await c.attach(TAB.handle)).ok, true);
    assert.equal((await c.attach(OTHER_TAB.handle)).error, AttachError.REATTACH);
    await withTimeout(c.closed, 'proxy to close the connection');
    assert.ok(ext.cdpCommands().every((m) => m.tabId === TAB.tabId));
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

// --- malformed requests ----------------------------------------------------------

// Each must be refused without taking the proxy down for everyone else.
const MALFORMED_LINES = [
  JSON.stringify({ id: 1, method: 'TabControl.attach', params: { handle: { toString: null } } }),
  JSON.stringify({ id: 1, method: 'TabControl.attach', params: { handle: 42 } }),
  JSON.stringify({ id: 1, method: 'TabControl.attach', params: null }),
  'null',
  '42',
];

test('malformed requests are refused and the proxy keeps serving', async () => {
  await withProxy([TAB], async ({ connect, ext }) => {
    for (const line of MALFORMED_LINES) {
      const c = await connect();
      c.conn.write(line + '\n');
      await withTimeout(c.closed, `proxy to close the connection after ${line}`);
      assert.equal(ext.proc.exitCode, null, `proxy exited after ${line}: ${ext.stderr}`);
    }
    const ok = await connect();
    assert.equal((await ok.attach(TAB.handle)).ok, true);
    ok.close();
  });
});

// --- remote access -------------------------------------------------------------

const FROM_REMOTE = { remote: 'devbox' };

test('a remote attach is refused while remote access is off for the tab', async () => {
  await withProxy([TAB], async ({ connect, ext }) => {
    const c = await connect();
    assert.equal((await c.attach(TAB.handle, FROM_REMOTE)).error, AttachError.REMOTE_DISABLED);
    await withTimeout(c.closed, 'server to close the connection');
    assert.equal(ext.cdpCommands().length, 0);
  });
});

test('a remote attach is admitted once remote access is on for the tab', async () => {
  await withProxy([{ ...TAB, remote: true }], async ({ connect }) => {
    const c = await connect();
    assert.equal((await c.attach(TAB.handle, FROM_REMOTE)).ok, true);
    assert.equal((await c.request('Page.enable')).result.tabId, TAB.tabId);
    c.close();
  });
});

test('a remote attach with an unknown handle gets the same error as a local one', async () => {
  await withProxy([TAB], async ({ connect }) => {
    const c = await connect();
    assert.equal((await c.attach('AAAA-BBBB-CCCC', FROM_REMOTE)).error, AttachError.UNKNOWN);
  });
});

test('turning remote access off disconnects remote clients but keeps local ones', async () => {
  await withProxy([{ ...TAB, remote: true }], async ({ connect, ext }) => {
    const remote = await connect();
    await remote.attach(TAB.handle, FROM_REMOTE);
    const local = await connect();
    await local.attach(TAB.handle);

    await ext.share({ ...TAB, remote: false });
    await withTimeout(remote.closed, 'remote client to be disconnected');
    assert.equal((await local.request('Page.enable')).result.tabId, TAB.tabId);

    const again = await connect();
    assert.equal((await again.attach(TAB.handle, FROM_REMOTE)).error, AttachError.REMOTE_DISABLED);
    local.close();
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

test('CLI watch stops with an error as soon as its tab is unshared', async () => {
  await withProxy([TAB], async ({ home, ext }) => {
    const started = Date.now();
    const run = runCli(home, ['watch', TAB.handle, '30']);
    await until(() => ext.cdpCommands().some((m) => m.method === 'Network.enable'), 'watch to start');
    await ext.unshare(TAB.tabId);
    const r = await withTimeout(run, 'watch to exit');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Disconnected from the tab/);
    assert.ok(Date.now() - started < 10_000);
  });
});

test('CLI watch says the connection was lost, not revoked, when the proxy goes away', async () => {
  await withProxy([TAB], async ({ home, ext }) => {
    const run = runCli(home, ['watch', TAB.handle, '30']);
    await until(() => ext.cdpCommands().some((m) => m.method === 'Network.enable'), 'watch to start');
    ext.proc.kill('SIGKILL');
    const r = await withTimeout(run, 'watch to exit');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Lost the connection to the tab/);
  });
});

test('CLI rejects an unknown handle without touching any tab', async () => {
  await withProxy([TAB], async ({ home, ext }) => {
    const r = await runCli(home, ['eval', 'AAAA-BBBB-CCCC', '1+1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No shared tab has the handle/);
    assert.match(r.stderr, /No remote link is up on this host/);
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
