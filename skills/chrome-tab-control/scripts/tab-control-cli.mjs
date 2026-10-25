#!/usr/bin/env node
// tab-control — CLI for interacting with shared Chrome tabs
// Works with the CDP Tab Control Chrome extension. No --remote-debugging-port needed.
//
// Usage: tab-control <command> <tab> [args]
//   <tab> is the tab handle the user gave you (e.g. K7QM-4XRT-AB12). Shared tabs
//   are never listed; the handle, copied to the user's clipboard when they share
//   a tab, is the only way to reach one. Run with --help for commands.

import net from 'net';
import vm from 'vm';
import { writeFileSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import {
  sockDir, PROXY_SOCKET_RE, REMOTE_SOCKET_RE, ATTACH_METHOD, AttachError,
  normalizeTabHandle, TAB_HANDLE_RE,
} from './protocol.mjs';
import { remoteCommand } from './remote-link.mjs';

const TIMEOUT = 15000;
// Sent by the proxy just before it ends a session on purpose (see tab-proxy.mjs).
const TAB_REVOKED_EVENT = '_tab_unshared';
const NAVIGATION_TIMEOUT = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Unix socket CDP client — talks to tab-proxy.mjs
// ---------------------------------------------------------------------------

class CdpSocket {
  #conn;
  #idCounter = 0;
  #pending = new Map();
  #eventHandlers = new Map();
  #buf = '';
  #markClosed;
  #isClosed = false;
  #revoked = false;
  // Resolves when the connection ends, for any reason; see revoked.
  closed = new Promise((r) => { this.#markClosed = r; });

  // True when the proxy ended the session on purpose: the tab was unshared,
  // or (for a client on a remote host) its remote access was turned off.
  get revoked() { return this.#revoked; }

  // Why the session ended, for every command it cut off, not only monitors.
  endReason() { return this.#revoked ? DISCONNECTED_REVOKED : DISCONNECTED_LOST; }

  connect(socketPath) {
    return new Promise((resolve, reject) => {
      this.#conn = net.connect(socketPath);
      this.#conn.on('connect', () => resolve());
      this.#conn.on('error', reject);
      this.#conn.on('data', (chunk) => this.#onData(chunk));
      this.#conn.on('close', () => {
        this.#isClosed = true;
        this.#markClosed();
        for (const { reject } of this.#pending.values()) {
          reject(new Error(this.endReason()));
        }
        this.#pending.clear();
      });
    });
  }

  #onData(chunk) {
    this.#buf += chunk.toString();
    const lines = this.#buf.split('\n');
    this.#buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);

      // CDP event from native host
      if (msg.event) {
        if (msg.event === TAB_REVOKED_EVENT) this.#revoked = true;
        const handlers = this.#eventHandlers.get(msg.event);
        if (handlers) {
          for (const h of [...handlers]) h(msg.params || {});
        }
        continue;
      }

      // Response to a command
      if (msg.id != null && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error));
      }
    }
  }

  send(method, params = {}, timeout = TIMEOUT) {
    if (this.#isClosed) return Promise.reject(new Error(this.endReason()));
    const id = ++this.#idCounter;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#conn.write(JSON.stringify({ id, method, params }) + '\n');
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, timeout);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    this.#eventHandlers.get(method).add(handler);
    return () => {
      this.#eventHandlers.get(method)?.delete(handler);
      if (this.#eventHandlers.get(method)?.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return { promise, cancel() { if (!settled) { settled = true; clearTimeout(timer); off?.(); } } };
  }

  close() {
    this.#conn?.end();
  }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

const DISCONNECTED_REVOKED = 'Disconnected from the tab: it was unshared, or its remote access was turned off.';
const DISCONNECTED_LOST = 'Lost the connection to the tab (Chrome, the tab proxy, or the remote link went away).';

// Waits out a monitoring window, but fails at once if the session ends, so a
// monitor never keeps reporting "0 events" from a tab it can no longer see.
async function monitorFor(cdp, ms) {
  const ended = cdp.closed.then(() => { throw new Error(cdp.endReason()); });
  await Promise.race([sleep(ms), ended]);
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) { seen.add(child.nodeId); children.push(child); }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) { seen.add(child.nodeId); children.push(child); }
  }
  return children;
}

async function snapshotStr(cdp) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const nodesById = new Map(nodes.map((n) => [n.nodeId, n]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }
  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, true)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) visit(child, depth + 1);
  }
  const roots = nodes.filter((n) => !n.parentId || !nodesById.has(n.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);
  return lines.join('\n');
}

async function picksStr(cdp) {
  await cdp.send('Runtime.enable');
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const els = document.querySelectorAll('[data-tc-highlighted]');
      if (!els.length) return 'No highlighted elements. Use Highlight (right-click > Highlight) to highlight page elements.';
      const out = [];
      els.forEach((el) => {
        const num = el.getAttribute('data-tc-highlighted');
        const tag = el.tagName.toLowerCase();
        let sel = tag;
        if (el.id) sel += '#' + el.id;
        const href = el.getAttribute('href');
        if (href) sel += '[href="' + href.slice(0, 80) + '"]';
        const role = el.getAttribute('role');
        if (role) sel += '[role="' + role + '"]';
        const type = el.getAttribute('type');
        if (tag === 'input' && type) sel += '[type="' + type + '"]';
        const name = el.getAttribute('name');
        if (name) sel += '[name="' + name + '"]';
        const cls = el.className && typeof el.className === 'string'
          ? el.className.trim().split(/\\s+/).slice(0, 3).join('.')
          : '';
        if (cls) sel += '.' + cls;
        const text = (el.getAttribute('aria-label') || el.innerText || '').trim();
        const rect = el.getBoundingClientRect();
        const pos = 'at=(' + Math.round(rect.left) + ',' + Math.round(rect.top)
          + ') size=' + Math.round(rect.width) + 'x' + Math.round(rect.height);
        out.push('#' + num + ' ' + sel + ' ' + pos + (text ? ' "' + text.slice(0, 80) + '"' : ''));
      });
      return out.join('\\n');
    })()`,
    returnByValue: true,
  });
  return result.value;
}

async function annotationsStr(cdp) {
  await cdp.send('Runtime.enable');
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const els = document.querySelectorAll('[data-tc-annotation]');
      if (!els.length) return 'No annotations found.';
      const out = [];
      els.forEach((el, i) => {
        const type = el.getAttribute('data-tc-annotation');
        const color = el.getAttribute('data-tc-color') || '';
        const tag = el.tagName;
        let desc = '';
        if (tag === 'ellipse') {
          desc = 'center=(' + Math.round(+el.getAttribute('cx')) + ',' + Math.round(+el.getAttribute('cy'))
            + ') rx=' + Math.round(+el.getAttribute('rx')) + ' ry=' + Math.round(+el.getAttribute('ry'));
        } else if (tag === 'rect') {
          desc = 'at=(' + Math.round(+el.getAttribute('x')) + ',' + Math.round(+el.getAttribute('y'))
            + ') size=' + Math.round(+el.getAttribute('width')) + 'x' + Math.round(+el.getAttribute('height'));
        } else if (tag === 'g') {
          const ln = el.querySelector('line[marker-end]') || el.querySelector('line');
          if (ln) desc = 'from=(' + Math.round(+ln.getAttribute('x1')) + ',' + Math.round(+ln.getAttribute('y1'))
            + ') to=(' + Math.round(+ln.getAttribute('x2')) + ',' + Math.round(+ln.getAttribute('y2')) + ')';
        } else if (tag === 'text') {
          desc = 'at=(' + Math.round(+el.getAttribute('x')) + ',' + Math.round(+el.getAttribute('y'))
            + ') text="' + el.textContent + '"';
        }
        // Find page elements under the annotation by sampling multiple points
        let under = '';
        const root = document.getElementById('__tc-annotate-root');
        if (root && (tag === 'ellipse' || tag === 'rect' || tag === 'text' || tag === 'g')) {
          const points = [];
          if (tag === 'g') {
            // Arrow: sample the tip
            const ln = el.querySelector('line[marker-end]') || el.querySelector('line');
            if (ln) points.push([+ln.getAttribute('x2'), +ln.getAttribute('y2')]);
          } else {
            // Sample a grid of points within the bounding box
            const bbox = el.getBBox();
            const cols = 3, rows = 3;
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                points.push([
                  bbox.x + bbox.width * (c + 0.5) / cols,
                  bbox.y + bbox.height * (r + 0.5) / rows,
                ]);
              }
            }
          }
          if (points.length) {
            const prev = root.style.display;
            root.style.display = 'none';
            const seen = new Set();
            const found = [];
            for (const [px, py] of points) {
              const pageEl = document.elementFromPoint(px, py);
              if (!pageEl) continue;
              // Deduplicate by element reference
              if (seen.has(pageEl)) continue;
              seen.add(pageEl);
              const text = (pageEl.getAttribute('aria-label') || pageEl.innerText || '').trim();
              if (!text) continue;
              const tag = pageEl.tagName.toLowerCase();
              let sel = tag;
              if (pageEl.id) sel += '#' + pageEl.id;
              const href = pageEl.getAttribute('href');
              if (href) sel += '[href="' + href + '"]';
              const role = pageEl.getAttribute('role');
              if (role) sel += '[role="' + role + '"]';
              const type = pageEl.getAttribute('type');
              if (tag === 'input' && type) sel += '[type="' + type + '"]';
              const name = pageEl.getAttribute('name');
              if (name) sel += '[name="' + name + '"]';
              found.push(sel + ' "' + text.slice(0, 80) + '"');
            }
            root.style.display = prev;
            if (found.length) under = ' -> ' + found.join(' | ');
          }
        }
        out.push('[' + type + '] ' + color + ' ' + desc + under);
      });
      return out.join('\\n');
    })()`,
    returnByValue: true,
  });
  return result.value;
}

async function evalValue(cdp, expression) {
  await cdp.send('Runtime.enable');
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return remoteObjectValue(result.result);
}

// CDP sends values JSON cannot carry (NaN, ±Infinity, -0, BigInt) as a string in
// unserializableValue instead of value.
export function remoteObjectValue({ value, unserializableValue }) {
  if (unserializableValue === undefined) return value;
  if (unserializableValue.endsWith('n')) return BigInt(unserializableValue.slice(0, -1));
  return Number(unserializableValue);
}

function formatValue(val) {
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function evalStr(cdp, expression) {
  return formatValue(await evalValue(cdp, expression));
}

async function shotStr(cdp, filePath, highlightSelector) {
  let dpr = 1;
  try {
    const raw = await evalStr(cdp, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) dpr = parsed;
  } catch {}

  // Inject highlight overlay if selector provided
  let highlightCount = 0;
  if (highlightSelector) {
    const countRaw = await evalStr(cdp, `
      (function() {
        const els = document.querySelectorAll(${JSON.stringify(highlightSelector)});
        els.forEach(el => {
          const rect = el.getBoundingClientRect();
          const overlay = document.createElement('div');
          overlay.setAttribute('data-tc-highlight', 'true');
          overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
            + 'border:3px solid #e53935;background:rgba(229,57,53,0.12);border-radius:3px;'
            + 'left:' + rect.left + 'px;top:' + rect.top + 'px;'
            + 'width:' + rect.width + 'px;height:' + rect.height + 'px;';
          document.body.appendChild(overlay);
        });
        return els.length;
      })()
    `);
    highlightCount = parseInt(countRaw) || 0;
  }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = filePath || '/tmp/screenshot.png';
  writeFileSync(out, Buffer.from(data, 'base64'));

  // Remove highlight overlays
  if (highlightSelector) {
    await evalStr(cdp, `
      document.querySelectorAll('[data-tc-highlight]').forEach(el => el.remove());
      'cleaned'
    `).catch(() => {});
  }

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  if (highlightCount > 0) {
    lines.push(`Highlighted ${highlightCount} element(s) matching "${highlightSelector}"`);
  }
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels -> CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) -> CSS (100, 200) -> use clickxy <tab> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, expr);
}

async function waitForDocumentReady(cdp, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, 'document.readyState');
      if (state === 'complete') return;
    } catch {}
    await sleep(200);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

const CLI_NAV_OVERRIDE = { crossOrigin: '--cross-origin', refresh: '"refresh"' };
const SCRIPT_NAV_OVERRIDE = { crossOrigin: '{ crossOrigin: true }', refresh: 'tab.refresh()' };

// Permission check: nav must stay on the same hostname unless --cross-origin.
// A tab on about:blank or chrome://* has no real origin to protect, so any nav is allowed.
// `override` names the opt-out in the caller's terms (CLI flag or script option).
async function assertSameHostNav(cdp, targetUrl, override = CLI_NAV_OVERRIDE) {
  const currentUrl = await evalStr(cdp, 'location.href');
  const currentHost = hostnameOf(currentUrl);
  if (!currentHost || /^(about:|chrome:|chrome-extension:|edge:)/i.test(currentUrl)) return;
  const targetHost = hostnameOf(targetUrl);
  if (!targetHost) {
    throw new Error(`Refusing nav: target URL has no hostname (${targetUrl}). Pass ${override.crossOrigin} to override.`);
  }
  if (currentHost !== targetHost) {
    throw new Error(`Refusing cross-host nav: ${currentHost} → ${targetHost}. Pass ${override.crossOrigin} to override, or use ${override.refresh} to reload the current URL.`);
  }
}

async function navStr(cdp, url) {
  await cdp.send('Page.enable');
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url });
  if (result.errorText) { loadEvent.cancel(); throw new Error(result.errorText); }
  if (result.loaderId) { await loadEvent.promise; } else { loadEvent.cancel(); }
  await waitForDocumentReady(cdp, 5000);
  return `Navigated to ${url}`;
}

async function refreshStr(cdp, hard = false) {
  await cdp.send('Page.enable');
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  try {
    await cdp.send('Page.reload', { ignoreCache: hard });
  } catch (e) {
    loadEvent.cancel();
    throw e;
  }
  await loadEvent.promise;
  await waitForDocumentReady(cdp, 5000);
  const url = await evalStr(cdp, 'location.href');
  return `${hard ? 'Hard-refreshed' : 'Refreshed'} ${url}`;
}

async function navWatchStr(cdp, url, postLoadSec = 2) {
  // Set up console + network monitoring BEFORE navigating
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  let count = 0;
  const messages = [];

  function record(line) {
    messages.push(line);
    process.stdout.write(line + '\n');
    count++;
  }

  cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    const ts = new Date(params.timestamp).toISOString().slice(11, 23);
    const level = (params.type || 'log').toUpperCase();
    record(`[CONSOLE ${level}] ${ts}  ${formatConsoleArgs(params.args)}`);
  });

  cdp.onEvent('Runtime.exceptionThrown', (params) => {
    const ts = new Date(params.timestamp).toISOString().slice(11, 23);
    const desc = params.exceptionDetails?.exception?.description
      || params.exceptionDetails?.text || 'Unknown';
    record(`[CONSOLE ERROR] ${ts}  ${desc}`);
  });

  cdp.onEvent('Log.entryAdded', (params) => {
    const entry = params.entry || {};
    const level = (entry.level || 'info').toUpperCase();
    record(`[LOG ${level}] ${entry.text || ''}  ${entry.url || ''}`);
  });

  cdp.onEvent('Network.requestWillBeSent', (params) => {
    const { request } = params;
    record(`[NET -->] ${request.method} ${request.url.substring(0, 120)}`);
  });

  cdp.onEvent('Network.responseReceived', (params) => {
    const { response } = params;
    record(`[NET <--] ${response.status} ${response.url.substring(0, 120)}  (${response.mimeType || ''})`);
  });

  cdp.onEvent('Network.loadingFailed', (params) => {
    const { errorText, canceled } = params;
    record(`[NET FAIL] ${canceled ? 'CANCELED' : errorText}`);
  });

  // Navigate
  console.error(`Navigating to ${url} with monitoring...`);
  await cdp.send('Page.enable');
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url });
  if (result.errorText) { loadEvent.cancel(); throw new Error(result.errorText); }
  if (result.loaderId) { await loadEvent.promise; } else { loadEvent.cancel(); }
  await waitForDocumentReady(cdp, 5000);

  // Continue monitoring for a bit after load to catch post-load errors
  console.error(`Page loaded. Monitoring for ${postLoadSec}s more...`);
  await monitorFor(cdp, postLoadSec * 1000);

  if (count === 0) return `Navigated to ${url}\nNo console/network events captured.`;
  return `Navigated to ${url}\n${count} event(s) captured.`;
}

async function netStr(cdp) {
  const raw = await evalStr(cdp, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map((e) =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

// A genuine pointer sequence. Synthetic .click() is ignored by some frameworks
// (notably Angular Material), and only real input grants transient user activation.
async function dispatchRealClick(cdp, x, y) {
  const base = { x, y, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

// Elements that actually respond to a click. Wrapper components (Angular/React
// custom elements) frequently carry the stable test id while the real target is
// an <a> or <button> inside them — clicking the wrapper is a silent no-op.
const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
  '[role="option"]', '[role="checkbox"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(', ');

async function clickStr(cdp, selector, { real = false, exact = false } = {}) {
  if (!selector) throw new Error('CSS selector required');

  // Resolve, redirect and click inside ONE evaluation. Frameworks that re-render
  // (Angular, React) routinely swap the node between two CDP round-trips, so a
  // resolve-then-click split silently fires on a detached element and does nothing.
  const info = await evalStr(cdp, `
    (function() {
      const sel = ${JSON.stringify(selector)};
      const el = document.querySelector(sel);
      if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ' + sel });
      el.scrollIntoView({ block: 'center', inline: 'center' });

      const INTERACTIVE = ${JSON.stringify(INTERACTIVE_SELECTOR)};
      let target = el, redirectedFrom = null;
      if (!${JSON.stringify(exact)} && !el.matches(INTERACTIVE)) {
        const inner = el.querySelector(INTERACTIVE);
        if (inner) { target = inner; redirectedFrom = el.tagName; }
      }

      const rect = target.getBoundingClientRect();
      // offsetParent is null for position:fixed elements, so it cannot serve as a
      // visibility test — it would reject modals, sticky toolbars and floating
      // buttons. checkVisibility() handles fixed, display:none and visibility:hidden.
      const visible = rect.width > 0 && rect.height > 0 && (
        typeof target.checkVisibility === 'function'
          ? target.checkVisibility()
          : getComputedStyle(target).visibility !== 'hidden'
      );
      const out = {
        ok: true,
        tag: target.tagName,
        redirectedFrom,
        visible,
        interactive: target.matches(INTERACTIVE),
        text: (target.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 60),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      if (visible && !${JSON.stringify(real)}) target.click();
      return JSON.stringify(out);
    })()
  `);

  const r = JSON.parse(info);
  if (!r.ok) throw new Error(r.error);

  if (!r.visible) {
    throw new Error(
      `Element for "${selector}" resolved to <${r.tag}> but is not visible ` +
      `(zero size or not rendered), so clicking it would do nothing. ` +
      `Wait for it to appear, or target the visible control.`
    );
  }

  if (real) {
    await dispatchRealClick(cdp, r.x, r.y);
  }

  let out = `Clicked <${r.tag}> "${r.text}"`;
  if (real) out += ' (real mouse events)';
  if (r.redirectedFrom) out += `\n  note: "${selector}" matched <${r.redirectedFrom}>, which is not clickable — clicked its inner <${r.tag}> instead.`;
  if (!r.interactive) out += `\n  warning: <${r.tag}> has no interactive role. If nothing happened, retry with --real.`;
  return out;
}

async function clickXyStr(cdp, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  await dispatchRealClick(cdp, cx, cy);
  return `Clicked at CSS (${cx}, ${cy})`;
}

async function typeStr(cdp, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text });
  return `Typed ${text.length} characters`;
}

// Focus an element. A synthetic .click() does NOT move focus to a contenteditable,
// so clicking a rich-text composer and then typing silently types into nothing.
async function focusStr(cdp, selector) {
  if (!selector) throw new Error('CSS selector required');
  const attempt = () => evalStr(cdp, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus({ preventScroll: true });
      const active = document.activeElement;
      const rect = el.getBoundingClientRect();
      return JSON.stringify({
        ok: true,
        focused: active === el || el.contains(active),
        tag: el.tagName,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        visible: rect.width > 0 && rect.height > 0,
      });
    })()
  `);

  let r = JSON.parse(await attempt());
  if (!r.ok) throw new Error(r.error);

  // Some editors only take focus from a genuine pointer event.
  if (!r.focused && r.visible) {
    await dispatchRealClick(cdp, r.x, r.y);
    r = JSON.parse(await attempt());
  }
  if (!r.focused) {
    throw new Error(`Could not move focus to "${selector}" (<${r.tag}>). Typing would go to the wrong element.`);
  }
  return `Focused <${r.tag}>`;
}

// Replace an element's entire content with `text`: focus it, select what is
// there, then insert. Input.insertText replaces the selection, so this both
// clears stale content and avoids appending to it.
async function fillStr(cdp, selector, text) {
  if (!selector) throw new Error('CSS selector required');
  if (text == null) throw new Error('text required');

  await focusStr(cdp, selector);
  await evalStr(cdp, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 0;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { el.select(); return 1; }
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return 1;
    })()
  `);
  await cdp.send('Input.insertText', { text });

  // Verify, so a silent no-op fails here rather than somewhere downstream.
  const got = await evalStr(cdp, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return '';
      return (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || '') : (el.textContent || '');
    })()
  `);
  if (!got.includes(text.trim().slice(0, 40))) {
    throw new Error(
      `Filled "${selector}" but its content does not contain the text. ` +
      `Expected to find ${JSON.stringify(text.slice(0, 40))}, element now holds ${JSON.stringify(got.slice(0, 80))}.`
    );
  }
  return `Filled <${selector}> with ${text.length} characters`;
}

// Chrome grants transient user activation to CDP-dispatched input only in a
// FOREGROUND tab. Sites that gate an action behind user activation therefore
// accept the click and silently do nothing while the tab is in the background.
async function bringToFrontStr(cdp) {
  await cdp.send('Page.bringToFront');
  // visibilitychange lands asynchronously, so poll briefly before reporting.
  let state = 'hidden';
  for (let i = 0; i < 10; i++) {
    state = await evalStr(cdp, 'document.visibilityState');
    if (state === 'visible') break;
    await sleep(100);
  }
  if (state !== 'visible') {
    throw new Error(
      `Tab was activated but still reports "${state}" — the Chrome window is probably ` +
      'minimised or on another desktop. Actions gated behind user activation (sending, ' +
      'uploads, clipboard) would silently do nothing, so this is reported as a failure.'
    );
  }
  return 'Tab brought to front (visible)';
}

// ---------------------------------------------------------------------------
// Key presses
// ---------------------------------------------------------------------------

// Input.insertText cannot produce key events, so text-only typing never submits
// a form or triggers a keyboard shortcut. These are dispatched as real key events.
const KEY_DEFS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

// CDP Input modifier bitmask
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const SHIFT_BIT = 8;
// Each press costs a round trip plus a gap, so an unbounded count would block for
// many minutes with no way to interrupt it cleanly.
const MAX_KEY_REPEAT = 500;

export function parseKeySpec(spec) {
  if (!spec) throw new Error(`key required, e.g. Enter, Shift+Enter, Escape. Known: ${Object.keys(KEY_DEFS).join(', ')}`);
  const parts = String(spec).split('+').map((part) => part.trim()).filter(Boolean);
  const name = (parts.pop() || '').toLowerCase();
  let modifiers = 0;
  for (const mod of parts) {
    const bit = MODIFIER_BITS[mod.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${mod}". Known: alt, ctrl, cmd, shift`);
    modifiers |= bit;
  }
  const def = KEY_DEFS[name];
  if (!def) throw new Error(`Unknown key "${name}". Known: ${Object.keys(KEY_DEFS).join(', ')}`);
  return { def, modifiers, label: (parts.length ? `${parts.join('+')}+` : '') + def.key };
}

export function parseRepeat(repeat) {
  if (repeat == null) return 1;
  const n = parseInt(repeat, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > MAX_KEY_REPEAT) throw new Error(`repeat count ${n} exceeds the maximum of ${MAX_KEY_REPEAT}`);
  return n;
}

async function keyStr(cdp, spec, repeat = 1) {
  const { def, modifiers, label } = parseKeySpec(spec);
  const n = parseRepeat(repeat);

  const base = {
    modifiers,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  };
  // Chrome suppresses the character payload when a non-shift modifier is held.
  const textPart = def.text && !(modifiers & ~SHIFT_BIT)
    ? { text: def.text, unmodifiedText: def.text }
    : {};

  for (let i = 0; i < n; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...textPart });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    if (i < n - 1) await sleep(20);
  }
  return n > 1 ? `Pressed ${label} x${n}` : `Pressed ${label}`;
}

// ---------------------------------------------------------------------------
// Wait for a page-side condition
// ---------------------------------------------------------------------------

export function parseWaitForArgs(args) {
  const skip = new Set();
  const numFlag = (flag, scale, unit) => {
    const i = args.indexOf(flag);
    if (i === -1) return null;
    const raw = parseFloat(args[i + 1]);
    if (!isFinite(raw) || raw <= 0) throw new Error(`${flag} requires a positive number of ${unit}`);
    skip.add(i);
    skip.add(i + 1);
    return Math.round(raw * scale);
  };
  const timeoutMs = numFlag('--timeout', 1000, 'seconds') ?? 60000;
  const intervalMs = numFlag('--interval', 1, 'milliseconds') ?? 250;
  const expression = args.filter((a, i) => !skip.has(i)).join(' ').trim();
  return { expression, timeoutMs, intervalMs };
}

// Polls from the CLI rather than inside a single evaluate, so the wait is not
// bounded by the per-command CDP TIMEOUT.
async function waitForStr(cdp, expression, { timeoutMs = 60000, intervalMs = 250 } = {}) {
  if (!expression) throw new Error('expression required');
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evalStr(cdp, `!!(${expression})`) === 'true') {
        return `Condition met after ${Date.now() - started}ms`;
      }
      lastError = null;
    } catch (e) {
      // A runtime error is expected while waiting for something to exist, but a
      // syntax error can never become true — fail now instead of at the timeout.
      if (/SyntaxError/.test(e.message)) {
        throw new Error(`Invalid JS expression: ${e.message}`);
      }
      lastError = e.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${expression.slice(0, 200)}` +
    (lastError ? ` (last evaluation error: ${lastError})` : '')
  );
}

async function loadAllStr(cdp, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, `!!document.querySelector(${JSON.stringify(selector)})`);
    if (exists !== 'true') break;
    const clicked = await evalStr(cdp, `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// ---------------------------------------------------------------------------
// Console & network monitoring
// ---------------------------------------------------------------------------

function formatConsoleArg(a) {
  if (a.type === 'string') return a.value;
  if (a.type === 'number' || a.type === 'boolean') return String(a.value);
  if (a.type === 'undefined') return 'undefined';
  if (a.type === 'object' && a.subtype === 'null') return 'null';
  // Use preview if available (CDP provides structured previews for objects)
  if (a.preview) return formatObjectPreview(a.preview);
  if (a.value !== undefined) return JSON.stringify(a.value);
  if (a.description) return a.description;
  return `[${a.type}]`;
}

function formatObjectPreview(preview) {
  if (!preview) return '[Object]';
  const { type, subtype, properties, entries, overflow } = preview;

  if (subtype === 'array') {
    const items = (properties || []).map((p) => formatPreviewProp(p, true));
    return `[${items.join(', ')}${overflow ? ', ...' : ''}]`;
  }

  if (subtype === 'date' || subtype === 'regexp') {
    return preview.description || `[${subtype}]`;
  }

  if (type === 'object') {
    const items = (properties || []).map((p) => formatPreviewProp(p, false));
    const desc = preview.description && preview.description !== 'Object'
      ? `${preview.description} ` : '';
    return `${desc}{${items.join(', ')}${overflow ? ', ...' : ''}}`;
  }

  return preview.description || `[${type}]`;
}

function formatPreviewProp(prop, isArray) {
  const val = formatPreviewValue(prop);
  return isArray ? val : `${prop.name}: ${val}`;
}

function formatPreviewValue(prop) {
  if (prop.type === 'string') return JSON.stringify(prop.value);
  if (prop.type === 'number' || prop.type === 'boolean') return String(prop.value);
  if (prop.type === 'undefined') return 'undefined';
  if (prop.type === 'object' && prop.subtype === 'null') return 'null';
  if (prop.type === 'object') {
    // Nested object — use valuePreview if available
    if (prop.valuePreview) return formatObjectPreview(prop.valuePreview);
    return prop.description || prop.value || '[Object]';
  }
  if (prop.type === 'function') return '[Function]';
  return prop.value !== undefined ? String(prop.value) : `[${prop.type}]`;
}

function formatConsoleArgs(args) {
  return (args || []).map(formatConsoleArg).join(' ');
}

async function installConsoleInterceptor(cdp) {
  await cdp.send('Runtime.evaluate', {
    expression: `
      if (!window.__cdpConsolePatched) {
        window.__cdpConsolePatched = true;
        const serialize = (v, depth) => {
          if (depth > 3) return typeof v === 'object' && v !== null ? '{...}' : String(v);
          if (v === null || v === undefined) return String(v);
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
          if (v instanceof Error) return v.stack || v.message;
          if (Array.isArray(v)) return v.map(x => serialize(x, depth + 1));
          if (typeof v === 'object') {
            const out = {};
            for (const [k, val] of Object.entries(v)) {
              try { out[k] = serialize(val, depth + 1); } catch { out[k] = '[circular]'; }
            }
            return out;
          }
          return String(v);
        };
        ['log','info','warn','error','debug'].forEach(level => {
          const orig = console[level].bind(console);
          console[level] = (...args) => {
            const serialized = args.map(a => {
              if (typeof a === 'object' && a !== null) {
                try { return JSON.stringify(serialize(a, 0)); } catch { return String(a); }
              }
              return a;
            });
            orig(...serialized);
          };
        });
      }
      'interceptor installed'
    `,
    returnByValue: true,
  });
}

async function removeConsoleInterceptor(cdp) {
  try {
    await cdp.send('Runtime.evaluate', {
      expression: `
        if (window.__cdpConsolePatched) {
          delete window.__cdpConsolePatched;
        }
        'removed'
      `,
      returnByValue: true,
    });
  } catch {}
}

async function consoleHistoryStr(cdp) {
  await cdp.send('Runtime.enable');

  // Read from __tc_console_history injected by the extension on share
  const raw = await evalStr(cdp, `
    (function() {
      const h = window.__tc_console_history;
      if (!h || !h.length) return '[]';
      return JSON.stringify(h);
    })()
  `);

  const entries = JSON.parse(raw);
  if (entries.length === 0) return 'No console history found. (History is captured from the moment the tab is shared.)';

  const lines = entries.map((e) => {
    const ts = new Date(e.ts).toISOString().slice(11, 23);
    const level = (e.level || 'log').toUpperCase().padEnd(7);
    return `${ts}  ${level}  ${e.text}`;
  });
  return lines.join('\n');
}

async function consoleClearStr(cdp) {
  await cdp.send('Runtime.enable');
  await evalStr(cdp, `
    (function() {
      if (window.__tc_console_history) window.__tc_console_history.length = 0;
    })()
  `);
  return 'Console history cleared.';
}

async function consoleStr(cdp, durationSec = 5) {
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await installConsoleInterceptor(cdp);

  const messages = [];

  cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    const ts = new Date(params.timestamp).toISOString().slice(11, 23);
    const level = (params.type || 'log').toUpperCase().padEnd(7);
    const text = formatConsoleArgs(params.args);
    const line = `${ts}  ${level}  ${text}`;
    messages.push(line);
    process.stdout.write(line + '\n');
  });

  cdp.onEvent('Runtime.exceptionThrown', (params) => {
    const ts = new Date(params.timestamp).toISOString().slice(11, 23);
    const desc = params.exceptionDetails?.exception?.description
      || params.exceptionDetails?.text || 'Unknown exception';
    const line = `${ts}  ERROR    ${desc}`;
    messages.push(line);
    process.stdout.write(line + '\n');
  });

  cdp.onEvent('Log.entryAdded', (params) => {
    const entry = params.entry || {};
    const ts = entry.timestamp ? new Date(entry.timestamp).toISOString().slice(11, 23) : '---';
    const level = (entry.level || 'info').toUpperCase().padEnd(7);
    const line = `${ts}  ${level}  ${entry.text || ''}  ${entry.url || ''}`;
    messages.push(line);
    process.stdout.write(line + '\n');
  });

  console.error(`Monitoring console for ${durationSec}s... (Ctrl+C to stop early)`);
  await monitorFor(cdp, durationSec * 1000);

  if (messages.length === 0) return 'No console messages captured.';
  return `\n${messages.length} message(s) captured.`;
}

async function requestsStr(cdp, durationSec = 5) {
  await cdp.send('Network.enable');

  const pending = new Map();  // requestId -> {method, url, timestamp}
  const completed = [];

  cdp.onEvent('Network.requestWillBeSent', (params) => {
    const { requestId, request, timestamp } = params;
    pending.set(requestId, {
      method: request.method,
      url: request.url,
      postData: request.postData,
      timestamp,
    });
    const line = `--> ${request.method} ${request.url.substring(0, 120)}`;
    process.stdout.write(line + '\n');
  });

  cdp.onEvent('Network.responseReceived', (params) => {
    const { requestId, response } = params;
    const req = pending.get(requestId);
    const method = req?.method || '?';
    const url = response.url || req?.url || '?';
    const status = response.status;
    const mime = response.mimeType || '';
    const line = `<-- ${status} ${method} ${url.substring(0, 100)}  (${mime})`;
    completed.push({ method, url, status, mime, postData: req?.postData });
    pending.delete(requestId);
    process.stdout.write(line + '\n');
  });

  cdp.onEvent('Network.loadingFailed', (params) => {
    const { requestId, errorText, canceled } = params;
    const req = pending.get(requestId);
    const url = req?.url || '?';
    const reason = canceled ? 'CANCELED' : errorText;
    const line = `<-- FAIL ${req?.method || '?'} ${url.substring(0, 100)}  (${reason})`;
    completed.push({ method: req?.method, url, status: 'FAIL', error: reason });
    pending.delete(requestId);
    process.stdout.write(line + '\n');
  });

  console.error(`Monitoring network for ${durationSec}s... (Ctrl+C to stop early)`);
  await monitorFor(cdp, durationSec * 1000);

  if (completed.length === 0 && pending.size === 0) return 'No network requests captured.';
  return `\n${completed.length} completed, ${pending.size} still pending.`;
}

async function watchStr(cdp, durationSec = 10) {
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await installConsoleInterceptor(cdp);

  let count = 0;

  cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    const ts = new Date(params.timestamp).toISOString().slice(11, 23);
    const level = (params.type || 'log').toUpperCase();
    process.stdout.write(`[CONSOLE ${level}] ${ts}  ${formatConsoleArgs(params.args)}\n`);
    count++;
  });

  cdp.onEvent('Runtime.exceptionThrown', (params) => {
    const ts = new Date(params.timestamp).toISOString().slice(11, 23);
    const desc = params.exceptionDetails?.exception?.description
      || params.exceptionDetails?.text || 'Unknown';
    process.stdout.write(`[CONSOLE ERROR] ${ts}  ${desc}\n`);
    count++;
  });

  cdp.onEvent('Log.entryAdded', (params) => {
    const entry = params.entry || {};
    const level = (entry.level || 'info').toUpperCase();
    process.stdout.write(`[LOG ${level}] ${entry.text || ''}  ${entry.url || ''}\n`);
    count++;
  });

  cdp.onEvent('Network.requestWillBeSent', (params) => {
    const { request } = params;
    process.stdout.write(`[NET -->] ${request.method} ${request.url.substring(0, 120)}\n`);
    if (request.postData) {
      process.stdout.write(`  POST body: ${request.postData.substring(0, 200)}\n`);
    }
    count++;
  });

  cdp.onEvent('Network.responseReceived', (params) => {
    const { response } = params;
    process.stdout.write(`[NET <--] ${response.status} ${response.url.substring(0, 120)}  (${response.mimeType || ''})\n`);
    count++;
  });

  cdp.onEvent('Network.loadingFailed', (params) => {
    const { requestId, errorText, canceled } = params;
    process.stdout.write(`[NET FAIL] ${canceled ? 'CANCELED' : errorText}\n`);
    count++;
  });

  console.error(`Watching console + network for ${durationSec}s... (Ctrl+C to stop early)`);
  await monitorFor(cdp, durationSec * 1000);

  return `\n${count} event(s) captured.`;
}

async function evalRawStr(cdp, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Scripts: many steps against one tab in a single call
// ---------------------------------------------------------------------------

const RUN_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;
// Script errors are reported as "<SCRIPT_FILENAME>:<line>", matching the script's own lines.
const SCRIPT_FILENAME = 'tab-script';
const STDIN_ARG = '-';
// The stack at the script line that called a tab method. Errors raised inside
// the CDP socket (timeouts, a revoked tab) carry no script frame of their own.
const SCRIPT_CALL_SITE = Symbol('scriptCallSite');

// Wraps a tab method so its errors remember the script line that called it.
const traced = (method) => async (...args) => {
  const callSite = new Error().stack;
  try {
    return await method(...args);
  } catch (e) {
    if (e instanceof Error && !e[SCRIPT_CALL_SITE]) e[SCRIPT_CALL_SITE] = callSite;
    throw e;
  }
};

const mapValues = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));

export function parseRunArgs(args) {
  let timeoutMs = RUN_TIMEOUT_DEFAULT_MS;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout') {
      const sec = parseFloat(args[i + 1]);
      if (!isFinite(sec) || sec <= 0) throw new Error('--timeout requires a positive number of seconds');
      timeoutMs = Math.round(sec * 1000);
      i++;
    } else {
      rest.push(args[i]);
    }
  }
  if (rest.length > 1) throw new Error(`run takes one script file (or ${STDIN_ARG} for stdin), got: ${rest.join(' ')}`);
  return { file: rest[0] ?? STDIN_ARG, timeoutMs };
}

// A page-side expression from either a JS string or a function. A function is
// serialized and called in the page with JSON-encoded args, so it cannot close
// over script variables — pass them as args instead.
export function toPageExpression(expr, args = []) {
  if (typeof expr === 'function') {
    const encoded = args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a)));
    return `(${expr.toString()})(${encoded.join(', ')})`;
  }
  if (typeof expr !== 'string' || !expr) throw new Error('expected a JS expression string or a function');
  if (args.length) throw new Error('args can only be passed with a function, not an expression string');
  return expr;
}

// The `tab` object a script receives. Methods mirror the CLI commands, with the
// same checks (e.g. same-host nav), and return the same reports, except eval,
// info and cdp, which return values.
function makeTabApi(cdp) {
  return Object.freeze(mapValues({
    info: () => evalValue(cdp, '({ url: location.href, title: document.title })'),
    eval: (expr, ...args) => evalValue(cdp, toPageExpression(expr, args)),
    cdp: (method, params = {}) => {
      if (method === ATTACH_METHOD) throw new Error(`${ATTACH_METHOD} is not allowed: a script works on its own tab only`);
      return cdp.send(method, params);
    },
    snap: () => snapshotStr(cdp),
    html: (selector) => htmlStr(cdp, selector),
    shot: (file, { highlight } = {}) => shotStr(cdp, file ?? null, highlight ?? null),
    nav: async (url, { crossOrigin = false } = {}) => {
      if (!crossOrigin) await assertSameHostNav(cdp, url, SCRIPT_NAV_OVERRIDE);
      return navStr(cdp, url);
    },
    refresh: ({ hard = false } = {}) => refreshStr(cdp, hard),
    click: (selector, { real = false, exact = false } = {}) => clickStr(cdp, selector, { real, exact }),
    clickxy: (x, y) => clickXyStr(cdp, x, y),
    type: (text) => typeStr(cdp, text),
    key: (spec, count = 1) => keyStr(cdp, spec, count),
    focus: (selector) => focusStr(cdp, selector),
    fill: (selector, text) => fillStr(cdp, selector, text),
    front: () => bringToFrontStr(cdp),
    waitfor: (expr, { timeout = 60, interval = 250, args = [] } = {}) =>
      waitForStr(cdp, toPageExpression(expr, args), { timeoutMs: timeout * 1000, intervalMs: interval }),
    loadall: (selector, intervalMs = 1500) => loadAllStr(cdp, selector, intervalMs),
    annotations: () => annotationsStr(cdp),
    pins: () => picksStr(cdp),
  }, traced));
}

// The script is the body of an async function of (tab, sleep), so top-level
// await and `return` work. Line numbers in errors match the script's lines.
function compileScript(source) {
  const wrapped = `(async function (tab, sleep) {\n${source}\n})`;
  return new vm.Script(wrapped, { filename: SCRIPT_FILENAME, lineOffset: -1 }).runInThisContext();
}

// Names the script line an error came from; the message alone often cannot.
function withScriptLine(error) {
  const stacks = `${error?.[SCRIPT_CALL_SITE] ?? ''}\n${error?.stack ?? ''}`;
  const line = stacks.match(new RegExp(`${SCRIPT_FILENAME}:(\\d+)`))?.[1];
  const message = error?.name === 'SyntaxError' ? `SyntaxError: ${error.message}` : String(error?.message ?? error);
  return new Error(line ? `${message} (script line ${line})` : message);
}

// Reads stdin as a stream: a synchronous read of a pipe whose writer has not
// finished fails with EAGAIN.
async function readStdin() {
  if (process.stdin.isTTY) {
    throw new Error('script required: pass a script file, or pipe it on stdin (e.g. a heredoc)');
  }
  let source = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

async function readScript(file) {
  const source = file === STDIN_ARG ? await readStdin() : readFileSync(file, 'utf8');
  if (!source.trim()) throw new Error(`script is empty (${file === STDIN_ARG ? 'nothing on stdin' : file})`);
  return source;
}

// Read and compile before attaching, so a bad script never touches the tab.
async function loadScript(args) {
  const { file, timeoutMs } = parseRunArgs(args);
  try {
    return { script: compileScript(await readScript(file)), timeoutMs };
  } catch (e) {
    throw withScriptLine(e);
  }
}

// Ends the run at the deadline or as soon as the tab connection drops (e.g. the
// tab was unshared while the script slept). At the deadline the connection is
// closed, so the script cannot act on the tab afterwards. A busy synchronous
// loop cannot be interrupted, though: the deadline is checked when it yields.
async function runStr(cdp, script, timeoutMs) {
  let timer;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Script did not finish within ${timeoutMs / 1000}s (raise it with --timeout <sec>)`));
      cdp.close();
    }, timeoutMs);
    // A step in flight fails on its own, with its script line; let it win.
    cdp.closed.then(() => setImmediate(() => reject(new Error(cdp.endReason()))));
  });
  // Whichever loses the race settles later; its outcome no longer matters.
  stopped.catch(() => {});
  const running = script(makeTabApi(cdp), sleep);
  running.catch(() => {});
  try {
    return formatValue(await Promise.race([running, stopped]));
  } catch (e) {
    throw withScriptLine(e);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tab resolution
// ---------------------------------------------------------------------------

const HANDLE_HINT = 'Ask the user to paste the tab handle (sharing copies it; the Tab Control popup also shows it; looks like K7QM-4XRT-AB12).';

const listDisabledMessage = () => `Listing shared tabs is disabled: each shared tab is reached only by its tab handle.
${HANDLE_HINT}
Then run e.g.: tab-control info <tab-handle>`;

// Local proxies (one per Chrome profile) and remote links from Chrome on other
// machines (see remote-link.mjs).
function tabEndpoints() {
  let names = [];
  try { names = readdirSync(sockDir()); } catch {}
  return names
    .filter((n) => PROXY_SOCKET_RE.test(n) || REMOTE_SOCKET_RE.test(n))
    .map((n) => resolve(sockDir(), n));
}

const LINK_HINT = 'If Chrome runs on another machine, the user links it to this host there: Tab Control popup > Remote hosts > Link'
  + ' (or `tab-control remote <this-host>`).';
const NOT_RUNNING = `Tab Control is not running. Ask the user to open Chrome with the Tab Control extension and share the tab. ${LINK_HINT}`;

// Tries the handle against every endpoint. The one reaching the tab accepts
// it; the others reject it and close. Returns {cdp, tab: {tabId, url, title}}.
async function attachToTab(handle) {
  let reachable = 0;
  let remoteReachable = false;
  let remoteDisabled = false;
  for (const path of tabEndpoints()) {
    const cdp = new CdpSocket();
    try { await cdp.connect(path); } catch { continue; }
    reachable++;
    if (REMOTE_SOCKET_RE.test(basename(path))) remoteReachable = true;
    try {
      return { cdp, tab: await cdp.send(ATTACH_METHOD, { handle }) };
    } catch (e) {
      if (e.message === AttachError.REMOTE_DISABLED) remoteDisabled = true;
      cdp.close();
    }
  }
  if (remoteDisabled) {
    throw new Error(`Remote access is off for tab "${handle}". Ask the user to turn on "Remote" for that tab in the Tab Control popup.`);
  }
  if (reachable === 0) throw new Error(NOT_RUNNING);
  // This host may run its own Chrome, whose proxy answered; the tab may be on
  // a Chrome elsewhere that is not linked here.
  const linkHint = remoteReachable ? '' : ` No remote link is up on this host either. ${LINK_HINT}`;
  throw new Error(`No shared tab has the handle "${handle}" (it may have been unshared). ${HANDLE_HINT}${linkHint}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `tab-control — interact with shared Chrome tabs (no --remote-debugging-port needed)

Usage: tab-control <command> [args]

  info  <tab>                       Show the tab's title and URL (check you have the right tab)
  snap  <tab>                       Accessibility tree snapshot
  eval  <tab> <expr>                Evaluate JS expression
  shot  <tab> [file]                Screenshot (default: /tmp/screenshot.png)
  shot  <tab> [file] --highlight <sel>  Screenshot with elements highlighted
  html  <tab> [selector]            Get HTML (full page or CSS selector)
  nav   <tab> <url>                 Navigate to URL and wait for load (same-host only)
  nav   <tab> <url> --watch [sec]   Navigate with console+network monitoring
  nav   <tab> <url> --cross-origin  Allow navigation to a different host
  refresh <tab> [--hard]            Reload current URL (--hard bypasses cache)
  net   <tab>                       Network performance entries (from Performance API)
  console <tab> [seconds]           Monitor console output (default 5s)
  console <tab> --history           Show buffered console/log entries
  console <tab> --clear            Clear console history buffer
  requests <tab> [seconds]          Monitor network requests (default 5s)
  watch <tab> [seconds]             Monitor console + network together (default 10s)
  click   <tab> <selector>          Click element by CSS selector
  click   <tab> <selector> --real   Click via real mouse events at element centre
  click   <tab> <selector> --exact  Never redirect to an inner clickable child
  clickxy <tab> <x> <y>             Click at CSS pixel coordinates
  type    <tab> <text>              Insert text at current focus (no key events)
  key     <tab> <key> [count]       Press a key: Enter, Shift+Enter, Escape, Tab...
  focus   <tab> <selector>          Move focus to an element (real click if needed)
  front   <tab>                     Bring the tab to the foreground (grants user activation)
  fill    <tab> <selector> <text>   Focus, select all, and replace content with text
  waitfor <tab> <js-expr>           Wait until a JS expression is truthy
  waitfor <tab> <expr> --timeout <sec> --interval <ms>
  loadall <tab> <selector> [ms]     Click until element disappears
  evalraw <tab> <method> [json]     Raw CDP command
  annotations <tab>                 List user-drawn annotations with page context
  pins <tab>                        List user-pinned elements (from Select)
  run <tab> [file|-] [--timeout <sec>]  Run a JS script of many steps in one call
                                    (stdin by default; see SKILL.md "Run a script")

  remote <ssh-dest> [--name <label>]  Run where Chrome is: link this Chrome to a remote
                                    host, so an agent there can reach tabs you share
                                    with "Remote" on. Runs until Ctrl-C.

<tab> is the tab handle the user gave you, e.g. K7QM-4XRT-AB12. Shared tabs
cannot be listed: the handle (copied to the clipboard when the user shares a
tab) is the only way to reach one. Treat it as a secret.

SETUP
  1. Load the Chrome extension from the extension/ directory
  2. Run: make install-tab-proxy
  3. Click the extension icon and "Share" the tab you want to expose
  4. Paste the tab handle (sharing copied it) to your AI agent

COORDINATES
  shot saves at native resolution. CDP Input events use CSS pixels.
  CSS px = screenshot image px / DPR (printed by shot).
`;

const NEEDS_TAB = new Set([
  'info', 'snap', 'snapshot', 'eval', 'shot', 'screenshot', 'html', 'nav', 'navigate',
  'refresh', 'reload',
  'net', 'network', 'console', 'requests', 'watch',
  'click', 'clickxy', 'type', 'loadall', 'evalraw', 'annotations', 'pins',
  'key', 'waitfor', 'focus', 'fill', 'front', 'run',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  if (cmd === 'remote') {
    process.exitCode = await remoteCommand(args);
    return;
  }

  if (cmd === 'list' || cmd === 'ls') {
    console.error(listDisabledMessage());
    process.exit(1);
  }

  if (!NEEDS_TAB.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const handle = normalizeTabHandle(args[0]);
  if (!handle) {
    console.error(`Error: tab handle required. ${HANDLE_HINT}`);
    process.exit(1);
  }
  if (!TAB_HANDLE_RE.test(handle)) {
    console.error(`Error: "${args[0]}" is not a tab handle. ${HANDLE_HINT}`);
    process.exit(1);
  }

  let run;
  if (cmd === 'run') {
    try {
      run = await loadScript(args.slice(1));
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  }

  let cdp, tab;
  try {
    ({ cdp, tab } = await attachToTab(handle));
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  const cmdArgs = args.slice(1);

  try {
    let result;
    switch (cmd) {
      case 'info': result = `Title: ${tab.title || ''}\nURL:   ${tab.url || ''}`; break;
      case 'snap': case 'snapshot': result = await snapshotStr(cdp); break;
      case 'annotations': result = await annotationsStr(cdp); break;
      case 'pins': result = await picksStr(cdp); break;
      case 'eval': {
        const expr = cmdArgs.join(' ');
        if (!expr) { console.error('Error: expression required'); process.exit(1); }
        result = await evalStr(cdp, expr);
        break;
      }
      case 'shot': case 'screenshot': {
        const hlIdx = cmdArgs.indexOf('--highlight');
        let filePath = null;
        let hlSelector = null;
        if (hlIdx !== -1) {
          hlSelector = cmdArgs[hlIdx + 1];
          if (!hlSelector || hlSelector.startsWith('--')) {
            console.error('Error: --highlight requires a CSS selector'); process.exit(1);
          }
          // File path is any arg before --highlight that doesn't start with --
          filePath = cmdArgs.find((a, i) => i !== hlIdx && i !== hlIdx + 1 && !a.startsWith('--')) || null;
        } else {
          filePath = cmdArgs[0] || null;
        }
        result = await shotStr(cdp, filePath, hlSelector);
        break;
      }
      case 'html': result = await htmlStr(cdp, cmdArgs[0]); break;
      case 'nav': case 'navigate': {
        const crossOrigin = cmdArgs.includes('--cross-origin');
        const watchIdx = cmdArgs.indexOf('--watch');
        let urlArg, postSec = 2;
        if (watchIdx !== -1) {
          const skipIndices = new Set([watchIdx]);
          const nextArg = cmdArgs[watchIdx + 1];
          if (nextArg && !nextArg.startsWith('--') && /^\d+$/.test(nextArg)) {
            postSec = parseInt(nextArg);
            skipIndices.add(watchIdx + 1);
          }
          urlArg = cmdArgs.find((a, i) => !skipIndices.has(i) && !a.startsWith('--'));
        } else {
          urlArg = cmdArgs.find((a) => !a.startsWith('--'));
        }
        if (!urlArg) { console.error('Error: URL required'); process.exit(1); }
        if (!crossOrigin) await assertSameHostNav(cdp, urlArg);
        result = watchIdx !== -1
          ? await navWatchStr(cdp, urlArg, postSec)
          : await navStr(cdp, urlArg);
        break;
      }
      case 'refresh': case 'reload': {
        const hard = cmdArgs.includes('--hard');
        result = await refreshStr(cdp, hard);
        break;
      }
      case 'net': case 'network': result = await netStr(cdp); break;
      case 'console': {
        if (cmdArgs[0] === '--history') {
          result = await consoleHistoryStr(cdp);
        } else if (cmdArgs[0] === '--clear') {
          result = await consoleClearStr(cdp);
        } else {
          result = await consoleStr(cdp, cmdArgs[0] ? parseInt(cmdArgs[0]) : 5);
        }
        break;
      }
      case 'requests': result = await requestsStr(cdp, cmdArgs[0] ? parseInt(cmdArgs[0]) : 5); break;
      case 'watch': result = await watchStr(cdp, cmdArgs[0] ? parseInt(cmdArgs[0]) : 10); break;
      case 'click': {
        const selector = cmdArgs.find((a) => !a.startsWith('--'));
        if (!selector) { console.error('Error: CSS selector required'); process.exit(1); }
        result = await clickStr(cdp, selector, {
          real: cmdArgs.includes('--real'),
          exact: cmdArgs.includes('--exact'),
        });
        break;
      }
      case 'clickxy': result = await clickXyStr(cdp, cmdArgs[0], cmdArgs[1]); break;
      case 'type': {
        const text = cmdArgs.join(' ');
        if (!text) { console.error('Error: text required'); process.exit(1); }
        result = await typeStr(cdp, text);
        break;
      }
      case 'loadall': result = await loadAllStr(cdp, cmdArgs[0], cmdArgs[1] ? parseInt(cmdArgs[1]) : 1500); break;
      case 'key': result = await keyStr(cdp, cmdArgs[0], cmdArgs[1]); break;
      case 'focus': result = await focusStr(cdp, cmdArgs[0]); break;
      case 'front': result = await bringToFrontStr(cdp); break;
      case 'fill': {
        const sel2 = cmdArgs[0];
        const text = cmdArgs.slice(1).join(' ');
        if (!sel2) { console.error('Error: CSS selector required'); process.exit(1); }
        result = await fillStr(cdp, sel2, text);
        break;
      }
      case 'waitfor': {
        const { expression, timeoutMs, intervalMs } = parseWaitForArgs(cmdArgs);
        if (!expression) { console.error('Error: JS expression required'); process.exit(1); }
        result = await waitForStr(cdp, expression, { timeoutMs, intervalMs });
        break;
      }
      case 'evalraw': {
        if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
        const jsonParams = cmdArgs.length > 2 ? cmdArgs.slice(1).join(' ') : cmdArgs[1];
        result = await evalRawStr(cdp, cmdArgs[0], jsonParams);
        break;
      }
      case 'run': result = await runStr(cdp, run.script, run.timeoutMs); break;
      default:
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }

    if (result) console.log(result);
  } catch (e) {
    console.error('Error:', e.message);
    process.exitCode = 1;
  } finally {
    if (cmd === 'console' || cmd === 'watch') {
      await removeConsoleInterceptor(cdp);
    }
    cdp.close();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
}

// Guarded so tests can import the exported parsers without running the CLI.
// Real paths, because import.meta.url has symlinks resolved (e.g. macOS /var ->
// /private/var, or a symlinked skills dir) while argv[1] does not.
const realPathOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };
const invokedDirectly = Boolean(process.argv[1])
  && realPathOrNull(process.argv[1]) === realPathOrNull(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
