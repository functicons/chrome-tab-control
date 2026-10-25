#!/usr/bin/env node
// Stand-in for ssh in remote-link tests (via TAB_CONTROL_SSH); the "remote
// host" is a directory on this machine.
//
//   fake-ssh [opts] <dest> <command>    runs <command> with HOME=$FAKE_REMOTE_HOME
//   fake-ssh -N ... -R <remote>:<local> <dest>
//                                       relays connections on <remote> to <local>
//                                       until killed, like sshd's reverse forward;
//                                       like sshd it does not unlink <remote> on exit
//
// Each -N session appends its pid to $FAKE_SSH_PIDS so a test can drop the link.
// A command matching the regex $FAKE_SSH_SLOW waits $FAKE_SSH_SLOW_MS first, like
// a host behind a slow jump host.

import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const remoteHome = process.env.FAKE_REMOTE_HOME;

if (!args.includes('-N')) {
  const command = args[args.length - 1];
  if (process.env.FAKE_SSH_SLOW && new RegExp(process.env.FAKE_SSH_SLOW).test(command)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SSH_SLOW_MS));
  }
  const r = spawnSync('sh', ['-c', command], {
    env: { ...process.env, HOME: remoteHome }, stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

const spec = args[args.indexOf('-R') + 1];
const sep = spec.indexOf(':');
const [remotePath, localPath] = [spec.slice(0, sep), spec.slice(sep + 1)];
if (process.env.FAKE_SSH_PIDS) appendFileSync(process.env.FAKE_SSH_PIDS, `${process.pid}\n`);

const server = net.createServer((conn) => {
  const upstream = net.connect(localPath);
  conn.pipe(upstream);
  upstream.pipe(conn);
  const closeBoth = () => { conn.destroy(); upstream.destroy(); };
  conn.on('error', closeBoth);
  upstream.on('error', closeBoth);
  conn.on('close', closeBoth);
  upstream.on('close', closeBoth);
});
server.on('error', (e) => {
  process.stderr.write(`fake-ssh: Error: remote port forwarding failed for listen path ${remotePath}: ${e.message}\n`);
  process.exit(255);
});
server.listen(remotePath);
// Exit without closing the server, so the socket file stays (as with sshd).
process.on('SIGTERM', () => process.exit(0));
