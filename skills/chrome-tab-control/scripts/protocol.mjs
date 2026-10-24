// Tab Control — constants and helpers shared by tab-proxy.mjs, the CLI and
// the remote link (remote-link.mjs).
//
// All sides must agree on where sockets live and how a client attaches to a
// tab, so these live in one module instead of being duplicated.
//
// Design: shared tabs are never listed. Each shared tab gets a random, secret
// tab handle from the extension, and the handle is the only way to reach the
// tab: a client connects to a socket and attaches with it (ATTACH_METHOD).

import { homedir } from 'os';
import { resolve } from 'path';
import { mkdirSync, lstatSync, chmodSync } from 'fs';

// Resolved lazily so tests can point HOME at a temp dir before calling these.
export const configDir = () => resolve(homedir(), '.chrome-tab-control');
export const sockDir = () => resolve(configDir(), 'sock');
// One socket per proxy process (one proxy per Chrome profile), keyed by pid.
export const proxySocketPath = (pid) => resolve(sockDir(), `proxy-${pid}.sock`);
export const PROXY_SOCKET_RE = /^proxy-(\d+)\.sock$/;

// A remote link (`tab-control remote <host>`, run where Chrome is) forwards a
// socket with this name into the remote host's sockDir over SSH, so a CLI on
// that host reaches the Chrome machine's tabs. The name never matches
// PROXY_SOCKET_RE: a proxy on the remote host deletes proxy sockets whose pid
// is not alive there.
export const REMOTE_SOCKET_RE = /^remote-[A-Za-z0-9._-]+\.sock$/;
const REMOTE_LABEL_MAX = 32;
export const remoteSocketLabel = (s) =>
  String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, REMOTE_LABEL_MAX) || 'chrome';
export const remoteSocketName = (label) => `remote-${remoteSocketLabel(label)}.sock`;

// Private to the user: other accounts must not reach the sockets.
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_SOCKET_MODE = 0o600;

// Creates dir with 0700 and refuses to use it unless it is a real directory
// owned by this user, so no other account can plant or reach our socket.
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is not owned by the current user`);
  chmodSync(dir, PRIVATE_DIR_MODE);
}

// Reserved request method (not a CDP domain). A client must send
// {id, method: ATTACH_METHOD, params: {handle}} before any CDP command; the
// reply is {tabId, url, title}. The remote link adds params.remote (the remote
// host's name); the proxy then admits the client only to tabs the user allowed
// remote access to.
export const ATTACH_METHOD = 'TabControl.attach';

export const AttachError = Object.freeze({
  REQUIRED: 'Not attached to a tab',
  UNKNOWN: 'Unknown tab handle',
  REMOTE_DISABLED: 'Remote access is off for this tab',
  // A remote connection attaches once, so the remote link's log of attaches
  // (it sees only a connection's first request) is complete.
  REMOTE_REATTACH: 'A remote connection cannot attach again; open a new connection',
});

// Request lines that are not a JSON object (e.g. `null`, `42`) are refused.
export const isRequestObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Tab handles are Crockford base32 in groups of 4, e.g. K7QM-4XRT-AB12. Matching
// ignores case and surrounding whitespace so a hand-typed handle still works.
export const normalizeTabHandle = (s) => String(s ?? '').trim().toUpperCase();
export const TAB_HANDLE_RE = /^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/;
