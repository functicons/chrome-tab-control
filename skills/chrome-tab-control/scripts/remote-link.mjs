// Tab Control — remote link: lets a CLI on another host reach tabs shared in
// this machine's Chrome, over an SSH reverse-forwarded Unix socket.
//
//   remote host:  tab-control CLI → ~/.chrome-tab-control/sock/remote-<name>.sock
//                     ══ ssh -R (encrypted, authenticated by SSH) ══▶
//   this host:    bridge-<id>.sock (bridge) → proxy-<pid>.sock (one per Chrome profile)
//
// The bridge gives SSH one stable local endpoint while proxies come and go
// with Chrome. For each connection it reads the client's attach request, stamps
// it as remote (params.remote = the host name) and offers it to each local
// proxy; the proxy that shares the tab admits it only if the user turned on
// remote access for that tab. The client then talks to that proxy directly.
//
// Access still needs the tab handle: the link only carries attach requests to
// the proxies, which reject unknown handles exactly as for a local client.

import net from 'net';
import { spawn, execFile } from 'child_process';
import { readdirSync, unlinkSync, chmodSync } from 'fs';
import { hostname } from 'os';
import { createHash } from 'crypto';
import { resolve } from 'path';
import {
  configDir, sockDir, PROXY_SOCKET_RE, ensurePrivateDir, PRIVATE_SOCKET_MODE,
  ATTACH_METHOD, AttachError, remoteSocketName, isRequestObject,
} from './protocol.mjs';

const MAX_REQUEST_LINE_BYTES = 64 * 1024;
const CLIENT_ATTACH_TIMEOUT_MS = 10_000;
const PROXY_REPLY_TIMEOUT_MS = 5_000;
const PREP_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
// ssh -N gives no "forward is up" signal; ExitOnForwardFailure makes it exit
// fast when the forward fails, so surviving this long means it is up.
const LINK_SETTLE_MS = 3_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
// A link that stayed up this long resets the retry backoff.
const STABLE_LINK_MS = 60_000;
// sun_path is 104 bytes on macOS (108 on Linux), including the NUL.
const MAX_SOCKET_PATH_BYTES = 103;

const SSH_KEEPALIVE_OPTS = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
// Never prompt: a reconnect loop cannot answer a password prompt.
const SSH_BATCH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

const timestamp = () => new Date().toTimeString().slice(0, 8);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// An ssh destination starting with '-' would be parsed as an ssh option.
export function validateSshDest(dest) {
  if (!dest || typeof dest !== 'string') return 'an SSH destination is required, e.g. tab-control remote devbox';
  if (dest.startsWith('-')) return `"${dest}" is not an SSH destination`;
  if (/\s/.test(dest)) return `"${dest}" is not an SSH destination (contains whitespace)`;
  return null;
}

// Parses `remote <ssh-dest> [--name <label>]`.
export function parseRemoteArgs(args) {
  let dest = null;
  let name = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') {
      name = args[++i];
      if (!name) return { error: '--name requires a value' };
    } else if (dest === null) {
      dest = args[i];
    } else {
      return { error: `unexpected argument "${args[i]}"` };
    }
  }
  const error = validateSshDest(dest);
  if (error) return { error };
  return { dest, socketName: remoteSocketName(name ?? hostname().split('.')[0]) };
}

// POSIX sh script for the remote host: makes the private socket dir (refusing
// symlinked dirs), removes a socket left by an earlier link (sshd does not
// unlink a forwarded socket when the link closes, and binding over it fails)
// but nothing that is not a socket, and prints $HOME, which ssh -R needs as an
// absolute path. socketName is [A-Za-z0-9._-] only. Contains no single quotes,
// so remoteShCommand can quote it whole.
export function buildPrepScript(socketName) {
  return [
    'set -e',
    'umask 077',
    'd="$HOME/.chrome-tab-control"',
    's="$d/sock"',
    `f="$s/${socketName}"`,
    'for p in "$d" "$s"; do if [ -L "$p" ]; then echo "$p is a symlink; refusing to use it" >&2; exit 1; fi; done',
    'mkdir -p "$s"',
    'chmod 700 "$d" "$s"',
    'if [ -S "$f" ]; then rm -f "$f"; elif [ -e "$f" ] || [ -L "$f" ]; then echo "$f exists and is not a socket; refusing to remove it" >&2; exit 1; fi',
    'printf "%s\\n" "$HOME"',
  ].join('\n');
}

// Runs script under sh whatever the remote login shell is (bash, zsh, fish).
const remoteShCommand = (script) => `sh -c ${shellQuote(script)}`;

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// One local bridge per (destination, remote socket name). Its fixed path doubles
// as a lock: a second link to the same pair finds the first one listening.
export function bridgeSocketPath(dest, socketName) {
  const id = createHash('sha256').update(`${dest}\0${socketName}`).digest('hex').slice(0, 12);
  return resolve(sockDir(), `bridge-${id}.sock`);
}

export function remoteSocketPath(remoteHome, socketName) {
  return `${remoteHome.replace(/\/+$/, '')}/.chrome-tab-control/sock/${socketName}`;
}

export function buildForwardArgs(dest, remotePath, localPath) {
  return [
    '-N', '-o', 'ExitOnForwardFailure=yes', ...SSH_BATCH_OPTS, ...SSH_KEEPALIVE_OPTS,
    '-R', `${remotePath}:${localPath}`, dest,
  ];
}

export const nextRetryDelay = (prevMs) => Math.min(RETRY_MAX_MS, prevMs ? prevMs * 2 : RETRY_MIN_MS);

const localProxySockets = () => {
  let names = [];
  try { names = readdirSync(sockDir()); } catch {}
  return names.filter((n) => PROXY_SOCKET_RE.test(n)).map((n) => resolve(sockDir(), n));
};

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

// Resolves with the first NDJSON line and pauses the socket, leaving any bytes
// after the line unread (unshifted) for whoever reads the socket next.
function readFirstLine(socket, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let buf = Buffer.alloc(0);
    const finish = (err, line) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onClose);
      if (err) reject(err); else resolvePromise(line);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if ((nl === -1 ? buf.length : nl) > MAX_REQUEST_LINE_BYTES) {
        finish(new Error('request line too long'));
        return;
      }
      if (nl === -1) return;
      socket.pause();
      const rest = buf.subarray(nl + 1);
      if (rest.length) socket.unshift(rest);
      finish(null, buf.subarray(0, nl).toString());
    };
    const onClose = () => finish(new Error('connection closed'));
    const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onClose);
  });
}

const parseJson = (line) => { try { return JSON.parse(line); } catch { return null; } };

function replyAndClose(conn, id, error) {
  conn.end(JSON.stringify({ id, ok: false, error }) + '\n');
}

// Offers the stamped attach line to one proxy. Returns {peer, replyLine} when
// the proxy accepted, else {error} (null when the proxy was unreachable).
async function tryAttach(socketPath, attachLine) {
  const peer = net.connect(socketPath);
  peer.on('error', () => {});
  try {
    await new Promise((res, rej) => { peer.once('connect', res); peer.once('error', rej); });
    peer.write(attachLine);
    const replyLine = await readFirstLine(peer, PROXY_REPLY_TIMEOUT_MS);
    const reply = parseJson(replyLine);
    if (reply?.ok) return { peer, reply, replyLine };
    peer.destroy();
    return { error: reply?.error ?? null };
  } catch {
    peer.destroy();
    return { error: null };
  }
}

function splice(a, b) {
  a.pipe(b);
  b.pipe(a);
  const closeBoth = () => { a.destroy(); b.destroy(); };
  a.once('close', closeBoth);
  b.once('close', closeBoth);
}

async function bridgeConnection(client, { label, listSockets, log }) {
  client.on('error', () => {});
  let line;
  try {
    line = await readFirstLine(client, CLIENT_ATTACH_TIMEOUT_MS);
  } catch {
    client.destroy();
    return;
  }
  const req = parseJson(line);
  if (!isRequestObject(req) || req.method !== ATTACH_METHOD) {
    return replyAndClose(client, req?.id ?? null, AttachError.REQUIRED);
  }
  const handle = req.params?.handle;
  if (typeof handle !== 'string') {
    log(`${label} was refused: malformed attach request`);
    return replyAndClose(client, req.id ?? null, AttachError.UNKNOWN);
  }

  // Rebuilt from known fields only. remote is the bridge's say, not the remote
  // client's: it overwrites anything the client sent.
  const stamped = JSON.stringify({ id: req.id, method: ATTACH_METHOD, params: { handle, remote: label } }) + '\n';
  let error = AttachError.UNKNOWN;
  for (const socketPath of listSockets()) {
    const r = await tryAttach(socketPath, stamped);
    if (r.peer) {
      log(`${label} attached to tab "${r.reply.result?.title ?? ''}"`);
      client.write(r.replyLine + '\n');
      splice(client, r.peer);
      return;
    }
    if (r.error === AttachError.REMOTE_DISABLED) error = r.error;
  }
  log(error === AttachError.REMOTE_DISABLED
    ? `${label} was refused a tab: remote access is off for it (turn on "Remote" in the Tab Control popup)`
    : `${label} was refused: unknown tab handle`);
  replyAndClose(client, req.id, error);
}

// label names the remote side in proxy logs and the audit log. listSockets
// returns the local proxy sockets; it is re-read per connection because
// proxies restart with Chrome.
export function createBridge({ label, listSockets = localProxySockets, log = () => {} }) {
  return net.createServer((client) => { bridgeConnection(client, { label, listSockets, log }); });
}

const canConnect = (socketPath) => new Promise((res) => {
  const c = net.connect(socketPath);
  c.once('connect', () => { c.destroy(); res(true); });
  c.once('error', () => res(false));
});

async function listenPrivate(server, socketPath) {
  try { unlinkSync(socketPath); } catch {}
  await new Promise((res, rej) => { server.once('error', rej); server.listen(socketPath, res); });
  chmodSync(socketPath, PRIVATE_SOCKET_MODE);
}

// ---------------------------------------------------------------------------
// Link supervisor: keeps `ssh -R` up, reconnecting with backoff
// ---------------------------------------------------------------------------

function runSsh(sshCommand, args, timeoutMs, onChild = () => {}) {
  return new Promise((res, rej) => {
    const child = execFile(sshCommand, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      onChild(null);
      if (err) rej(new Error((stderr || err.message).trim()));
      else res(stdout);
    });
    onChild(child);
  });
}

async function prepareRemote(sshCommand, dest, socketName, onChild) {
  const out = await runSsh(sshCommand, [...SSH_BATCH_OPTS, dest, remoteShCommand(buildPrepScript(socketName))],
    PREP_TIMEOUT_MS, onChild);
  const remoteHome = out.trim().split('\n').pop();
  if (!remoteHome?.startsWith('/')) throw new Error(`could not read $HOME on ${dest} (got "${remoteHome}")`);
  const remotePath = remoteSocketPath(remoteHome, socketName);
  if (Buffer.byteLength(remotePath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`remote socket path is too long for a Unix socket: ${remotePath}; use a shorter --name`);
  }
  return remotePath;
}

// Runs one ssh -R session; resolves with how long it stayed up and the last
// line ssh printed to stderr (its reason for failing), when it exits or stop()
// is called. stdout is never inherited: in the tab proxy it is the native
// messaging channel to Chrome.
function forwardOnce(sshCommand, args, { onChild, onUp }) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(sshCommand, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    onChild(child);
    let lastError = '';
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      const lines = chunk.toString().trim().split('\n').filter(Boolean);
      if (lines.length) lastError = lines.at(-1);
    });
    const settle = setTimeout(onUp, LINK_SETTLE_MS);
    let done = false;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      onChild(null);
      res({ upMs: Date.now() - started, code, signal, lastError });
    };
    child.once('exit', finish);
    // A spawn failure may emit only 'error', never 'exit'.
    child.once('error', (e) => { lastError = `ssh failed to start: ${e.message}`; finish(null, null); });
  });
}

// Link states reported through onState(state, message).
export const LinkState = Object.freeze({
  CONNECTING: 'connecting',
  LINKED: 'linked',
  RETRYING: 'retrying',
  STOPPED: 'stopped',
});

// Links this machine's shared tabs to dest until stopped. log receives the
// audit trail (attaches, refusals) and progress lines; onState receives state
// changes. listSockets limits which local proxies the link reaches (default:
// all of them, i.e. every Chrome profile). Returns {stop}.
export async function startRemoteLink({
  dest, socketName, sshCommand = 'ssh', log = defaultLog, onState = () => {}, listSockets,
}) {
  ensurePrivateDir(configDir());
  ensurePrivateDir(sockDir());
  const bridgePath = bridgeSocketPath(dest, socketName);
  if (await canConnect(bridgePath)) {
    throw new Error(`a link to ${dest} (${socketName}) is already running; stop it first, or pass a different --name`);
  }
  const bridge = createBridge({ label: dest, log, ...(listSockets && { listSockets }) });
  await listenPrivate(bridge, bridgePath);

  let stopping = false;
  let child = null;
  let remotePath = null;
  let wake = () => {};
  let retryTimer = null;

  const loop = (async () => {
    let delay = 0;
    while (!stopping) {
      let reason;
      try {
        onState(LinkState.CONNECTING, `Connecting to ${dest}`);
        remotePath = await prepareRemote(sshCommand, dest, socketName, (c) => { child = c; });
        if (stopping) break;
        const { upMs, code, signal, lastError } = await forwardOnce(sshCommand,
          buildForwardArgs(dest, remotePath, bridgePath), {
            onChild: (c) => { child = c; },
            onUp: () => {
              const msg = `Linked to ${dest}. Tabs with "Remote" on are reachable there by tab handle.`;
              log(msg);
              onState(LinkState.LINKED, msg);
            },
          });
        if (stopping) break;
        if (upMs >= STABLE_LINK_MS) delay = 0;
        reason = `Link to ${dest} closed (${lastError || signal || `exit ${code}`})`;
      } catch (e) {
        reason = `Cannot link to ${dest}: ${e.message}`;
      }
      if (stopping) break;
      delay = nextRetryDelay(delay);
      log(reason);
      log(`Retrying in ${Math.round(delay / 1000)}s`);
      onState(LinkState.RETRYING, `${reason}. Retrying in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => { wake = r; retryTimer = setTimeout(r, delay); });
    }
  })();

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(retryTimer);
    wake();
    child?.kill('SIGTERM');
    await loop;
    bridge.close();
    try { unlinkSync(bridgePath); } catch {}
    // sshd leaves the forwarded socket behind; remove it so it does not linger.
    if (remotePath) {
      await runSsh(sshCommand, [...SSH_BATCH_OPTS, dest, remoteShCommand(`[ -S ${shellQuote(remotePath)} ] && rm -f ${shellQuote(remotePath)}`)],
        CLEANUP_TIMEOUT_MS).catch(() => {});
    }
    log(`Unlinked from ${dest}`);
    onState(LinkState.STOPPED, `Unlinked from ${dest}`);
  }

  return { stop, bridgePath };
}

function defaultLog(msg) {
  process.stderr.write(`[${timestamp()}] ${msg}\n`);
}

// CLI entry: `tab-control remote <ssh-dest> [--name <label>]`. Runs until
// SIGINT/SIGTERM.
export async function remoteCommand(args, { sshCommand = process.env.TAB_CONTROL_SSH || 'ssh' } = {}) {
  const parsed = parseRemoteArgs(args);
  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\nUsage: tab-control remote <ssh-dest> [--name <label>]\n`);
    return 1;
  }
  defaultLog(`Linking to ${parsed.dest} ... (Ctrl-C to unlink)`);
  let link;
  try {
    link = await startRemoteLink({ dest: parsed.dest, socketName: parsed.socketName, sshCommand });
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }
  await new Promise((res) => {
    const onSignal = () => { link.stop().then(res); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
  return 0;
}
