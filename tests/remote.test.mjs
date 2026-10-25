// Tests for the remote link (remote-link.mjs): reaching tabs shared in this
// machine's Chrome from a CLI on another host, over an SSH-forwarded socket.
//
// The end-to-end tests run `tab-control remote` with a fake ssh
// (fixtures/fake-ssh.mjs) whose "remote host" is a second temp HOME, so the
// whole chain — remote CLI → forwarded socket → bridge → proxy — runs locally.
//
// Run: make test   (or: node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  rmSync, statSync, readdirSync, readFileSync, existsSync, mkdirSync, closeSync, openSync, symlinkSync,
} from 'node:fs';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCRIPTS, CLI, TAB, OTHER_TAB, withTimeout, until, Client, makeHome, startProxy, withProxy, runCli,
} from './helpers.mjs';

const {
  parseRemoteArgs, buildPrepScript, buildForwardArgs, remoteSocketPath, nextRetryDelay, createBridge,
} = await import(resolve(SCRIPTS, 'remote-link.mjs'));
const {
  ATTACH_METHOD: ATTACH, AttachError, PROXY_SOCKET_RE, REMOTE_SOCKET_RE, remoteSocketName,
} = await import(resolve(SCRIPTS, 'protocol.mjs'));

const FAKE_SSH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-ssh.mjs');
const DEST = 'devbox';
const LINK_NAME = 'laptop';
// Covers the link's retry delay plus its ssh start-up.
const RELINK_WAIT_MS = 10_000;

// --- argument parsing and ssh invocation -----------------------------------------

test('parseRemoteArgs takes a destination and an optional --name', () => {
  assert.deepEqual(parseRemoteArgs(['devbox', '--name', 'work laptop']),
    { dest: 'devbox', socketName: 'remote-work-laptop.sock' });
  assert.match(parseRemoteArgs(['user@devbox']).socketName, REMOTE_SOCKET_RE);
});

test('parseRemoteArgs refuses a missing destination, an ssh option, and extra arguments', () => {
  assert.match(parseRemoteArgs([]).error, /SSH destination is required/);
  assert.match(parseRemoteArgs(['-oProxyCommand=touch /tmp/x']).error, /not an SSH destination/);
  assert.match(parseRemoteArgs(['devbox', 'extra']).error, /unexpected argument/);
  assert.match(parseRemoteArgs(['devbox', '--name']).error, /--name requires a value/);
});

test('remote socket names are safe file names that a proxy never treats as its own', () => {
  for (const label of ['../../etc/passwd', 'a b;rm -rf ~', '', '...', 'x'.repeat(200), 'proxy-1']) {
    const name = remoteSocketName(label);
    assert.match(name, REMOTE_SOCKET_RE, label);
    assert.doesNotMatch(name, PROXY_SOCKET_RE, label);
    assert.ok(!name.includes('/'), label);
  }
});

test('the forward fails fast instead of running without its socket', () => {
  const args = buildForwardArgs(DEST, '/home/u/r.sock', '/l/b.sock');
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.equal(args[args.indexOf('-R') + 1], '/home/u/r.sock:/l/b.sock');
  assert.equal(args.at(-1), DEST);
});

test('remoteSocketPath is absolute under the remote socket directory', () => {
  assert.equal(remoteSocketPath('/home/u/', 'remote-x.sock'), '/home/u/.chrome-tab-control/sock/remote-x.sock');
});

test('retry delay doubles from 2s and stops growing at 60s', () => {
  const delays = [];
  let d = 0;
  for (let i = 0; i < 8; i++) delays.push(d = nextRetryDelay(d));
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

// Leaves a socket file behind, as sshd does when a forward closes.
function makeStaleSocket(path) {
  const r = spawnSync(process.execPath, ['-e',
    `require('net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`]);
  assert.equal(r.status, 0, r.stderr.toString());
}

const runPrep = (home, name = 'remote-x.sock') =>
  spawnSync('sh', ['-c', buildPrepScript(name)], { env: { ...process.env, HOME: home } });

test('the remote prep script makes a private socket dir, clears a stale socket, prints $HOME', () => {
  const home = makeHome();
  try {
    const sock = `${home}/.chrome-tab-control/sock`;
    mkdirSync(sock, { recursive: true, mode: 0o755 });
    makeStaleSocket(`${sock}/remote-x.sock`);
    closeSync(openSync(`${sock}/proxy-5.sock`, 'w'));
    const r = runPrep(home);
    assert.equal(r.status, 0, r.stderr.toString());
    assert.equal(r.stdout.toString(), `${home}\n`);
    assert.deepEqual(readdirSync(sock), ['proxy-5.sock']);
    for (const dir of ['.chrome-tab-control', '.chrome-tab-control/sock']) {
      assert.equal(statSync(`${home}/${dir}`).mode & 0o777, 0o700, dir);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the remote prep script refuses a symlinked socket dir', () => {
  const home = makeHome();
  try {
    mkdirSync(`${home}/.chrome-tab-control`, { mode: 0o700 });
    mkdirSync(`${home}/elsewhere`);
    symlinkSync(`${home}/elsewhere`, `${home}/.chrome-tab-control/sock`);
    const r = runPrep(home);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr.toString(), /symlink/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the remote prep script never deletes a file that is not a socket', () => {
  const home = makeHome();
  try {
    const sock = `${home}/.chrome-tab-control/sock`;
    mkdirSync(sock, { recursive: true });
    closeSync(openSync(`${sock}/remote-x.sock`, 'w'));
    const r = runPrep(home);
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(`${sock}/remote-x.sock`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- bridge -------------------------------------------------------------------

// Runs a bridge in front of the proxies' sockets, as `tab-control remote` does.
async function withBridge(home, listSockets, fn) {
  const path = `${home}/bridge.sock`;
  const log = [];
  const bridge = createBridge({ label: DEST, listSockets, log: (m) => log.push(m) });
  await new Promise((r) => bridge.listen(path, r));
  try {
    await fn({ connect: () => Client.connect(path), log });
  } finally {
    bridge.close();
  }
}

test('bridge marks attaches as remote, whatever the client claims', async () => {
  await withProxy([TAB], async ({ ext, home }) => {
    await withBridge(home, () => [ext.socketPath], async ({ connect }) => {
      const c = await connect();
      const reply = await c.attach(TAB.handle, { remote: null });
      assert.equal(reply.error, AttachError.REMOTE_DISABLED);
      assert.equal(ext.cdpCommands().length, 0);
    });
  });
});

test('bridge carries commands and events once the tab allows remote access', async () => {
  await withProxy([{ ...TAB, remote: true }], async ({ ext, home }) => {
    await withBridge(home, () => [ext.socketPath], async ({ connect, log }) => {
      const c = await connect();
      assert.deepEqual((await c.attach(TAB.handle)).result, { tabId: TAB.tabId, url: TAB.url, title: TAB.title });
      assert.equal((await c.request('Page.enable')).result.tabId, TAB.tabId);
      ext.send({ type: 'cdp_event', tabId: TAB.tabId, method: 'Page.loadEventFired', params: {} });
      await until(() => c.events('Page.loadEventFired').length === 1, 'event through the bridge');
      assert.ok(log.some((m) => m.includes(`${DEST} attached to tab "${TAB.title}"`)), log.join('\n'));
      c.close();
    });
  });
});

test('a remote connection cannot attach again, so the link sees every remote attach', async () => {
  await withProxy([{ ...TAB, remote: true }, OTHER_TAB, { ...TAB, tabId: 9, handle: 'RRRR-RRRR-RRRR', remote: true }],
    async ({ ext, home }) => {
      await withBridge(home, () => [ext.socketPath], async ({ connect }) => {
        const c = await connect();
        assert.equal((await c.attach(TAB.handle)).ok, true);
        assert.equal((await c.attach('RRRR-RRRR-RRRR')).error, AttachError.REMOTE_REATTACH);
        await withTimeout(c.closed, 'proxy to close the connection');
        assert.ok(ext.cdpCommands().every((m) => m.tabId === TAB.tabId));
      });
    });
});

test('bridge refuses a malformed attach without passing it to any proxy', async () => {
  await withProxy([{ ...TAB, remote: true }], async ({ ext, home }) => {
    await withBridge(home, () => [ext.socketPath], async ({ connect }) => {
      for (const params of [{ handle: { toString: null } }, { handle: 42 }, null]) {
        const c = await connect();
        assert.equal((await c.request(ATTACH, params)).error, AttachError.UNKNOWN);
      }
      assert.equal(ext.proc.exitCode, null, ext.stderr);
      assert.doesNotMatch(ext.stderr, /Attach rejected/);
    });
  });
});

test('bridge refuses a first request line over 64 KiB, however it is split', async () => {
  await withProxy([{ ...TAB, remote: true }], async ({ ext, home }) => {
    await withBridge(home, () => [ext.socketPath], async ({ connect }) => {
      const line = JSON.stringify({ id: 1, method: ATTACH, params: { handle: TAB.handle, pad: 'x'.repeat(70_000) } });
      const c = await connect();
      c.conn.write(line.slice(0, 65_536));
      c.conn.write(line.slice(65_536) + '\n');
      await withTimeout(c.closed, 'bridge to drop the connection');
      assert.equal(c.lines.length, 0);
    });
  });
});

test('bridge refuses anything but an attach as the first request', async () => {
  await withProxy([{ ...TAB, remote: true }], async ({ ext, home }) => {
    await withBridge(home, () => [ext.socketPath], async ({ connect }) => {
      const c = await connect();
      assert.equal((await c.request('Runtime.evaluate', { expression: '1' })).error, AttachError.REQUIRED);
      await withTimeout(c.closed, 'bridge to close the connection');
      assert.equal(ext.cdpCommands().length, 0);
    });
  });
});

test('bridge finds the tab across proxies and skips dead sockets', async () => {
  const home = makeHome();
  const first = await startProxy(home);
  const second = await startProxy(home);
  try {
    await first.share({ ...TAB, remote: true });
    await second.share({ ...OTHER_TAB, remote: true });
    const sockets = () => [`${home}/dead.sock`, first.socketPath, second.socketPath];
    await withBridge(home, sockets, async ({ connect }) => {
      const c = await connect();
      assert.equal((await c.attach(OTHER_TAB.handle)).result.tabId, OTHER_TAB.tabId);
      const u = await connect();
      assert.equal((await u.attach('AAAA-BBBB-CCCC')).error, AttachError.UNKNOWN);
      c.close();
    });
  } finally {
    await first.stop();
    await second.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// --- tab-control remote, end to end -----------------------------------------------

const remoteSockPath = (remoteHome) => `${remoteHome}/.chrome-tab-control/sock/remote-${LINK_NAME}.sock`;
const localSockets = (localHome) => readdirSync(`${localHome}/.chrome-tab-control/sock`);
const sshSessions = (pidFile) => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) : []);

async function waitForPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function retryUntilOk(run, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let r;
  do { r = await run(); } while (r.code !== 0 && Date.now() < deadline);
  return r;
}

// Starts a proxy (the Chrome machine) and `tab-control remote` linking it to a
// fake remote host, waits for the forwarded socket, runs fn, then unlinks.
async function withRemoteLink(tabs, fn) {
  const local = makeHome();
  const remote = makeHome();
  const pidFile = `${local}/ssh-pids`;
  let ext = await startProxy(local);
  const link = spawn(process.execPath, [CLI, 'remote', DEST, '--name', LINK_NAME], {
    env: { ...process.env, HOME: local, TAB_CONTROL_SSH: FAKE_SSH, FAKE_REMOTE_HOME: remote, FAKE_SSH_PIDS: pidFile },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let linkLog = '';
  link.stderr.on('data', (c) => { linkLog += c; });
  const exited = once(link, 'exit');
  const unlink = async () => {
    if (link.exitCode === null) link.kill('SIGINT');
    return exited;
  };
  try {
    for (const tab of tabs) await ext.share(tab);
    await waitForPath(remoteSockPath(remote));
    await fn({
      local, remote, pidFile, unlink,
      ext: () => ext,
      restartProxy: async () => { await ext.stop(); ext = await startProxy(local); return ext; },
      linkLog: () => linkLog,
      remoteCli: (args) => runCli(remote, args),
    });
  } finally {
    await unlink();
    await ext.stop();
    rmSync(local, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
}

test('a CLI on the remote host reaches a tab whose remote access is on', async () => {
  await withRemoteLink([{ ...TAB, remote: true }], async ({ remoteCli, linkLog }) => {
    const r = await remoteCli(['eval', TAB.handle, '1+1']);
    assert.equal(r.stdout.trim(), `tab ${TAB.tabId} evaluated 1+1`, r.stderr);
    assert.match(linkLog(), new RegExp(`${DEST} attached to tab "${TAB.title}"`));
  });
});

test('with a link up, an unknown handle is not blamed on a missing link', async () => {
  await withRemoteLink([{ ...TAB, remote: true }], async ({ remoteCli }) => {
    const r = await remoteCli(['info', 'AAAA-BBBB-CCCC']);
    assert.match(r.stderr, /No shared tab has the handle/);
    assert.doesNotMatch(r.stderr, /No remote link is up/);
  });
});

test('a CLI on the remote host is told to ask for remote access when it is off', async () => {
  await withRemoteLink([TAB], async ({ remoteCli, ext }) => {
    const r = await remoteCli(['eval', TAB.handle, '1+1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Remote access is off for tab/);
    assert.equal(ext().cdpCommands().length, 0);
  });
});

test('the link survives a Chrome restart (a new proxy with a new socket)', async () => {
  await withRemoteLink([], async ({ remoteCli, restartProxy }) => {
    const ext = await restartProxy();
    await ext.share({ ...TAB, remote: true });
    const r = await remoteCli(['info', TAB.handle]);
    assert.match(r.stdout, /Title: Example/, r.stderr);
  });
});

test('the link comes back after the ssh connection drops, despite the stale socket', async () => {
  await withRemoteLink([{ ...TAB, remote: true }], async ({ remoteCli, pidFile }) => {
    const [first] = sshSessions(pidFile);
    process.kill(first, 'SIGKILL');
    const deadline = Date.now() + RELINK_WAIT_MS;
    while (sshSessions(pidFile).length < 2) {
      if (Date.now() > deadline) throw new Error('link did not reconnect');
      await new Promise((r) => setTimeout(r, 50));
    }
    // The new session records its pid just before it binds the socket.
    const r = await retryUntilOk(() => remoteCli(['info', TAB.handle]));
    assert.match(r.stdout, /Title: Example/, r.stderr);
  });
});

test('a second link to the same host and name is refused, and the first keeps working', async () => {
  await withRemoteLink([{ ...TAB, remote: true }], async ({ local, remote, remoteCli }) => {
    const second = await runCli(local, ['remote', DEST, '--name', LINK_NAME], {
      TAB_CONTROL_SSH: FAKE_SSH, FAKE_REMOTE_HOME: remote,
    }, 5000);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already running/);
    const r = await remoteCli(['info', TAB.handle]);
    assert.match(r.stdout, /Title: Example/, r.stderr);
  });
});

test('Ctrl-C while waiting to retry exits at once', async () => {
  const home = makeHome();
  try {
    const link = spawn(process.execPath, [CLI, 'remote', DEST], {
      env: { ...process.env, HOME: home, TAB_CONTROL_SSH: '/usr/bin/false' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '';
    link.stderr.on('data', (c) => { log += c; });
    await until(() => log.includes('Retrying in'), 'link to start waiting');
    const stopped = Date.now();
    link.kill('SIGINT');
    await withTimeout(once(link, 'exit'), 'link to exit');
    assert.ok(Date.now() - stopped < 1000, `took ${Date.now() - stopped}ms`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unlinking removes the forwarded and bridge sockets', async () => {
  await withRemoteLink([{ ...TAB, remote: true }], async ({ local, remote, unlink, remoteCli }) => {
    const [code] = await withTimeout(unlink(), 'link to exit');
    assert.equal(code, 0);
    assert.equal(existsSync(remoteSockPath(remote)), false);
    assert.deepEqual(localSockets(local).filter((n) => n.startsWith('bridge-')), []);
    const r = await remoteCli(['info', TAB.handle]);
    assert.match(r.stderr, /Tab Control is not running/);
  });
});
