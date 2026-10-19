// Tab Control — constants shared by tab-proxy.mjs and tab-control-cli.mjs.
//
// Both sides must agree on where sockets live and how a client attaches to a
// tab, so these live in one module instead of being duplicated.
//
// Design: shared tabs are never listed. Each shared tab gets a random, secret
// tab handle from the extension, and the handle is the only way to reach the
// tab: a client connects to a proxy socket and attaches with it (ATTACH_METHOD).

import { homedir } from 'os';
import { resolve } from 'path';

// Resolved lazily so tests can point HOME at a temp dir before calling these.
export const configDir = () => resolve(homedir(), '.chrome-tab-control');
export const sockDir = () => resolve(configDir(), 'sock');
// One socket per proxy process (one proxy per Chrome profile), keyed by pid.
export const proxySocketPath = (pid) => resolve(sockDir(), `proxy-${pid}.sock`);
export const PROXY_SOCKET_RE = /^proxy-(\d+)\.sock$/;

// Private to the user: other accounts must not reach the sockets.
export const PRIVATE_DIR_MODE = 0o700;

// Reserved request method (not a CDP domain). A client must send
// {id, method: ATTACH_METHOD, params: {handle}} before any CDP command; the
// reply is {tabId, url, title}.
export const ATTACH_METHOD = 'TabControl.attach';

export const AttachError = Object.freeze({
  REQUIRED: 'Not attached to a tab',
  UNKNOWN: 'Unknown tab handle',
});

// Tab handles are Crockford base32 in groups of 4, e.g. K7QM-4XRT-AB12. Matching
// ignores case and surrounding whitespace so a hand-typed handle still works.
export const normalizeTabHandle = (s) => String(s ?? '').trim().toUpperCase();
export const TAB_HANDLE_RE = /^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/;
