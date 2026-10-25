// Tests for remote links managed from the extension popup: the link manager
// (link-manager.mjs) on its own, and the tab proxy running real links when the
// extension asks (link_start / link_stop / links_status), over a fake ssh.
//
// Run: make test   (or: node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRIPTS, TAB, OTHER_TAB, withTimeout, makeHome, startProxy, runCli } from './helpers.mjs';

const { createLinkManager, LINK_ERROR } = await import(resolve(SCRIPTS, 'link-manager.mjs'));
const { LinkState } = await import(resolve(SCRIPTS, 'remote-link.mjs'));

const FAKE_SSH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-ssh.mjs');
const DEST = 'devbox';
// Covers the link's settle time (it reports "linked" after ~3s up).
const LINK_UP_WAIT_MS = 10_000;

const settle = () => new Promise((r) => setImmediate(r));

async function waitFor(pred, what, timeoutMs = LINK_UP_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// A stand-in for startRemoteLink that the test drives by hand.
function fakeStarter({ fail } = {}) {
  const started = [];
  const startLink = async (opts) => {
    if (fail) throw new Error(fail);
    const link = { opts, stopped: false, stop: async () => { link.stopped = true; } };
    started.push(link);
    return link;
  };
  return { started, startLink };
}

// --- link manager ------------------------------------------------------------------

test('a started link reports its state and the audit lines it logs', async () => {
  const { started, startLink } = fakeStarter();
  const links = createLinkManager({ startLink, now: () => '12:00:00' });
  links.start(DEST);
  assert.deepEqual(links.snapshot().map((l) => [l.dest, l.state]), [[DEST, LinkState.CONNECTING]]);

  await settle();
  started[0].opts.onState(LinkState.LINKED, 'Linked');
  started[0].opts.log('devbox attached to tab "Example"');
  assert.deepEqual(links.snapshot(), [{
    dest: DEST, state: LinkState.LINKED, message: 'Linked',
    activity: ['12:00:00 devbox attached to tab "Example"'],
  }]);
});

test('starting a host that is already linked does not start a second link', async () => {
  const { started, startLink } = fakeStarter();
  const links = createLinkManager({ startLink });
  links.start(DEST);
  links.start(DEST);
  await settle();
  assert.equal(started.length, 1);
});

test('an invalid destination or a failed start shows as an error, not a link', async () => {
  const links = createLinkManager({ startLink: fakeStarter({ fail: 'already running' }).startLink });
  links.start('-oProxyCommand=x');
  links.start(DEST);
  await settle();
  const byDest = Object.fromEntries(links.snapshot().map((l) => [l.dest, l]));
  assert.equal(byDest['-oProxyCommand=x'].state, LINK_ERROR);
  assert.equal(byDest[DEST].state, LINK_ERROR);
  assert.match(byDest[DEST].message, /already running/);
});

test('stopping a link stops it and removes it, even while it is still starting', async () => {
  const { started, startLink } = fakeStarter();
  const links = createLinkManager({ startLink });
  links.start(DEST);
  await links.stop(DEST);
  assert.equal(started[0].stopped, true);
  assert.deepEqual(links.snapshot(), []);
});

test('a link shows as unlinking until it has finished stopping', async () => {
  let finishStop;
  const startLink = async (opts) => ({
    stop: () => { opts.onState(LinkState.UNLINKING, 'Unlinking'); return new Promise((r) => { finishStop = r; }); },
  });
  const links = createLinkManager({ startLink });
  links.start(DEST);
  await settle();
  const stopped = links.stop(DEST);
  await settle();
  assert.equal(links.snapshot()[0].state, LinkState.UNLINKING);
  finishStop();
  await stopped;
  assert.deepEqual(links.snapshot(), []);
});

test('stopAll stops every link', async () => {
  const { started, startLink } = fakeStarter();
  const links = createLinkManager({ startLink });
  links.start('a');
  links.start('b');
  await links.stopAll();
  assert.deepEqual(started.map((l) => l.stopped), [true, true]);
  assert.deepEqual(links.snapshot(), []);
});

test('each profile gets its own remote socket name', async () => {
  const { started, startLink } = fakeStarter();
  const links = createLinkManager({ startLink });
  links.start(DEST, 'aaaaaa');
  await settle();
  const other = createLinkManager({ startLink });
  other.start(DEST, 'bbbbbb');
  await settle();
  const [a, b] = started.map((l) => l.opts.socketName);
  assert.notEqual(a, b);
  assert.match(a, /-aaaaaa\.sock$/);
  assert.match(b, /-bbbbbb\.sock$/);
});

test('the activity list keeps only the latest lines', async () => {
  const { started, startLink } = fakeStarter();
  const links = createLinkManager({ startLink });
  links.start(DEST);
  await settle();
  for (let i = 0; i < 9; i++) started[0].opts.log(`line ${i}`);
  const activity = links.snapshot()[0].activity;
  assert.equal(activity.length, 5);
  assert.match(activity.at(-1), /line 8$/);
});

// --- the proxy running links for the extension --------------------------------------

const lastLinks = (ext) => ext.received.filter((m) => m.type === 'links_status').at(-1)?.links;
const linkState = (ext) => lastLinks(ext)?.find((l) => l.dest === DEST)?.state;
const remoteSocketsIn = (home) => {
  const dir = `${home}/.chrome-tab-control/sock`;
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('remote-')) : [];
};

// A proxy whose ssh is the fake one, with a second temp HOME as the remote host.
async function withLinkingProxy(fn) {
  const local = makeHome();
  const remote = makeHome();
  const ext = await startProxy(local, { TAB_CONTROL_SSH: FAKE_SSH, FAKE_REMOTE_HOME: remote });
  try {
    await fn({ ext, local, remote });
  } finally {
    await ext.stop();
    rmSync(local, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
}

test('the extension links a host through the proxy, and an agent there reaches the tab', async () => {
  await withLinkingProxy(async ({ ext, remote }) => {
    await ext.share({ ...TAB, remote: true });
    ext.send({ type: 'link_start', dest: DEST });
    await waitFor(() => linkState(ext) === LinkState.LINKED, 'link to come up');

    const r = await runCli(remote, ['info', TAB.handle]);
    assert.match(r.stdout, /Title: Example/, r.stderr);
    await waitFor(() => lastLinks(ext)[0].activity.some((a) => a.includes(`${DEST} attached to tab "Example"`)),
      'the attach to show in the link activity');
  });
});

test('unlinking from the extension cuts the host off and removes its socket there', async () => {
  await withLinkingProxy(async ({ ext, remote }) => {
    await ext.share({ ...TAB, remote: true });
    ext.send({ type: 'link_start', dest: DEST });
    await waitFor(() => linkState(ext) === LinkState.LINKED, 'link to come up');

    ext.send({ type: 'link_stop', dest: DEST });
    await waitFor(() => lastLinks(ext).length === 0, 'link to be removed');
    assert.deepEqual(remoteSocketsIn(remote), []);
    const r = await runCli(remote, ['info', TAB.handle]);
    assert.match(r.stderr, /Tab Control is not running/);
  });
});

test('a link from one profile reaches only that profile\'s tabs', async () => {
  const local = makeHome();
  const remote = makeHome();
  const env = { TAB_CONTROL_SSH: FAKE_SSH, FAKE_REMOTE_HOME: remote };
  const mine = await startProxy(local, env);
  const otherProfile = await startProxy(local, env);
  try {
    await mine.share({ ...TAB, remote: true });
    await otherProfile.share({ ...OTHER_TAB, remote: true });
    mine.send({ type: 'link_start', dest: DEST, profile: 'mine01' });
    await waitFor(() => linkState(mine) === LinkState.LINKED, 'link to come up');

    assert.match((await runCli(remote, ['info', TAB.handle])).stdout, /Title: Example/);
    const r = await runCli(remote, ['info', OTHER_TAB.handle]);
    assert.equal(r.code, 1);
    assert.equal(otherProfile.cdpCommands().length, 0);
  } finally {
    await mine.stop();
    await otherProfile.stop();
    rmSync(local, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test('two profiles can link the same host at once', async () => {
  const local = makeHome();
  const remote = makeHome();
  const env = { TAB_CONTROL_SSH: FAKE_SSH, FAKE_REMOTE_HOME: remote };
  const a = await startProxy(local, env);
  const b = await startProxy(local, env);
  try {
    await a.share({ ...TAB, remote: true });
    await b.share({ ...OTHER_TAB, remote: true });
    a.send({ type: 'link_start', dest: DEST, profile: 'prof0a' });
    b.send({ type: 'link_start', dest: DEST, profile: 'prof0b' });
    await waitFor(() => linkState(a) === LinkState.LINKED && linkState(b) === LinkState.LINKED, 'both links up');
    assert.equal(remoteSocketsIn(remote).length, 2);
    assert.match((await runCli(remote, ['info', TAB.handle])).stdout, /Title: Example/);
    assert.match((await runCli(remote, ['info', OTHER_TAB.handle])).stdout, /Title: Other/);
  } finally {
    await a.stop();
    await b.stop();
    rmSync(local, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test('links end when the proxy exits (Chrome quits), leaving no socket on the host', async () => {
  const local = makeHome();
  const remote = makeHome();
  try {
    const ext = await startProxy(local, { TAB_CONTROL_SSH: FAKE_SSH, FAKE_REMOTE_HOME: remote });
    ext.send({ type: 'link_start', dest: DEST });
    await waitFor(() => linkState(ext) === LinkState.LINKED, 'link to come up');
    assert.equal(remoteSocketsIn(remote).length, 1);

    ext.proc.stdin.end();
    const [code] = await withTimeout(once(ext.proc, 'exit'), 'proxy to exit');
    assert.equal(code, 0);
    assert.deepEqual(remoteSocketsIn(remote), []);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
