// Tab Control — remote links managed from the extension popup.
//
// The tab proxy owns these links (see remote-link.mjs): the user starts and
// stops them in the popup, and they end when the proxy does, i.e. when Chrome
// quits. Links started in a terminal (`tab-control remote`) are separate and
// not listed here.
//
// Links are per Chrome profile: each profile has its own extension and proxy,
// so a link reaches only its own proxy (listSockets), and its remote socket
// name carries the profile's id so two profiles can link the same host.

import { hostname } from 'os';
import { startRemoteLink, validateSshDest, LinkState } from './remote-link.mjs';
import { remoteSocketName } from './protocol.mjs';

const ACTIVITY_KEEP = 5;
// Leaves room for the profile id within the socket label limit (32), so a long
// host name can never cut it off and make two profiles collide.
const HOST_LABEL_MAX = 20;
// State of a link that could not start (bad destination, or already linked
// elsewhere, e.g. from a terminal).
export const LINK_ERROR = 'error';

const clock = () => new Date().toTimeString().slice(0, 8);

// onChange() is called after every change; read the links with snapshot().
// listSockets returns the owning proxy's socket. startLink is injectable for tests.
export function createLinkManager({
  sshCommand = 'ssh', onChange = () => {}, startLink = startRemoteLink, now = clock, listSockets,
} = {}) {
  const links = new Map(); // dest -> {state, message, activity, ready: Promise<link|null>}

  const update = (dest, fields) => {
    const entry = links.get(dest);
    if (!entry) return;
    Object.assign(entry, fields);
    onChange();
  };

  const record = (dest, text) => {
    const entry = links.get(dest);
    if (!entry) return;
    entry.activity = [...entry.activity, `${now()} ${text}`].slice(-ACTIVITY_KEEP);
    onChange();
  };

  // profile: the Chrome profile's id, from the extension.
  function start(dest, profile = '') {
    const invalid = validateSshDest(dest);
    if (invalid) {
      links.set(dest, { state: LINK_ERROR, message: invalid, activity: [], ready: Promise.resolve(null) });
      onChange();
      return;
    }
    const existing = links.get(dest);
    if (existing && existing.state !== LINK_ERROR) return;

    const entry = { state: LinkState.CONNECTING, message: `Connecting to ${dest}`, activity: [] };
    links.set(dest, entry);
    entry.ready = startLink({
      dest,
      socketName: remoteSocketName([hostname().split('.')[0].slice(0, HOST_LABEL_MAX), profile].filter(Boolean).join('-')),
      sshCommand,
      listSockets,
      log: (text) => record(dest, text),
      onState: (state, message) => update(dest, { state, message }),
    }).catch((e) => {
      update(dest, { state: LINK_ERROR, message: e.message });
      return null;
    });
    onChange();
  }

  async function stop(dest) {
    const entry = links.get(dest);
    if (!entry) return;
    const link = await entry.ready;
    await link?.stop();
    if (links.get(dest) === entry) links.delete(dest);
    onChange();
  }

  const stopAll = () => Promise.all([...links.keys()].map(stop));

  const snapshot = () => [...links].map(([dest, { state, message, activity }]) => ({ dest, state, message, activity }));

  return { start, stop, stopAll, snapshot };
}
