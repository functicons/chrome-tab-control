#!/usr/bin/env node
// tab-control — CLI for interacting with shared Chrome tabs
// Works with the CDP Tab Control Chrome extension. No --remote-debugging-port needed.
//
// Usage: tab-control <command> [args]
//   list                              List shared tabs
//   snap  <tabId>                     Accessibility tree snapshot
//   eval  <tabId> <expr>              Evaluate JS expression
//   shot  <tabId> [file]              Screenshot (default: /tmp/screenshot.png)
//   html  <tabId> [selector]          Get HTML (full page or element)
//   nav   <tabId> <url>               Navigate and wait for load
//   net   <tabId>                     Network performance entries
//   click   <tabId> <selector>        Click element by CSS selector
//   clickxy <tabId> <x> <y>           Click at CSS pixel coordinates
//   type    <tabId> <text>            Type text at current focus
//   loadall <tabId> <selector> [ms]   Click until element disappears
//   evalraw <tabId> <method> [json]   Raw CDP command
//
// Shared tabs are managed via the Tab Control Chrome extension popup.

import net from 'net';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

const CONFIG_DIR = resolve(homedir(), '.chrome-tab-control');
const SHARED_TABS_FILE = resolve(CONFIG_DIR, 'shared-tabs.json');
const SOCK_PREFIX = '/tmp/chrome-tab-control/tab-';
const TIMEOUT = 15000;
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

  connect(socketPath) {
    return new Promise((resolve, reject) => {
      this.#conn = net.connect(socketPath);
      this.#conn.on('connect', () => resolve());
      this.#conn.on('error', reject);
      this.#conn.on('data', (chunk) => this.#onData(chunk));
      this.#conn.on('close', () => {
        for (const { reject } of this.#pending.values()) {
          reject(new Error('Connection closed'));
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
      const els = document.querySelectorAll('[data-tc-pinned]');
      if (!els.length) return 'No pinned elements. Use Select (right-click > Select) to pin page elements.';
      const out = [];
      els.forEach((el) => {
        const num = el.getAttribute('data-tc-pinned');
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

async function evalStr(cdp, expression) {
  await cdp.send('Runtime.enable');
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, filePath) {
  let dpr = 1;
  try {
    const raw = await evalStr(cdp, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) dpr = parsed;
  } catch {}

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = filePath || '/tmp/screenshot.png';
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
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

async function navStr(cdp, url) {
  await cdp.send('Page.enable');
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url });
  if (result.errorText) { loadEvent.cancel(); throw new Error(result.errorText); }
  if (result.loaderId) { await loadEvent.promise; } else { loadEvent.cancel(); }
  await waitForDocumentReady(cdp, 5000);
  return `Navigated to ${url}`;
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

async function clickStr(cdp, selector) {
  if (!selector) throw new Error('CSS selector required');
  const result = await evalStr(cdp, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} });
      el.scrollIntoView({ block: 'center' });
      el.click();
      return JSON.stringify({ ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) });
    })()
  `);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

async function clickXyStr(cdp, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  return `Clicked at CSS (${cx}, ${cy})`;
}

async function typeStr(cdp, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text });
  return `Typed ${text.length} characters`;
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
  await sleep(durationSec * 1000);

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
  await sleep(durationSec * 1000);

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
  await sleep(durationSec * 1000);

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
// Tab resolution
// ---------------------------------------------------------------------------

function loadSharedTabs() {
  if (!existsSync(SHARED_TABS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(SHARED_TABS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function resolveTabId(prefix, tabs) {
  const p = String(prefix);
  const matches = tabs.filter((t) => String(t.tabId).startsWith(p));
  if (matches.length === 0) throw new Error(`No shared tab matching "${prefix}". Run "tab-control list".`);
  if (matches.length > 1) throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} tabs. Use more digits.`);
  return matches[0].tabId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `tab-control — interact with shared Chrome tabs (no --remote-debugging-port needed)

Usage: tab-control <command> [args]

  list                              List shared tabs
  snap  <tab>                       Accessibility tree snapshot
  eval  <tab> <expr>                Evaluate JS expression
  shot  <tab> [file]                Screenshot (default: /tmp/screenshot.png)
  html  <tab> [selector]            Get HTML (full page or CSS selector)
  nav   <tab> <url>                 Navigate to URL and wait for load
  net   <tab>                       Network performance entries (from Performance API)
  console <tab> [seconds]           Monitor console output (default 5s)
  requests <tab> [seconds]          Monitor network requests (default 5s)
  watch <tab> [seconds]             Monitor console + network together (default 10s)
  click   <tab> <selector>          Click element by CSS selector
  clickxy <tab> <x> <y>             Click at CSS pixel coordinates
  type    <tab> <text>              Type text at current focus
  loadall <tab> <selector> [ms]     Click until element disappears
  evalraw <tab> <method> [json]     Raw CDP command
  annotations <tab>                 List user-drawn annotations with page context
  pins <tab>                        List user-pinned elements (from Select)

<tab> is a tab ID from "tab-control list" (or a unique prefix).

SETUP
  1. Load the Chrome extension from the extension/ directory
  2. Run: make install-tab-proxy
  3. Click the extension icon and "Share" the tabs you want to expose
  4. Use this CLI or let your AI agent use it

COORDINATES
  shot saves at native resolution. CDP Input events use CSS pixels.
  CSS px = screenshot image px / DPR (printed by shot).
`;

const NEEDS_TAB = new Set([
  'snap', 'snapshot', 'eval', 'shot', 'screenshot', 'html', 'nav', 'navigate',
  'net', 'network', 'console', 'requests', 'watch',
  'click', 'clickxy', 'type', 'loadall', 'evalraw', 'annotations', 'pins',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // List shared tabs
  if (cmd === 'list' || cmd === 'ls') {
    const tabs = loadSharedTabs();
    if (tabs.length === 0) {
      console.log('No shared tabs. Open the Tab Control extension and share a tab.');
      return;
    }
    const idWidth = Math.max(...tabs.map((t) => String(t.tabId).length));
    for (const t of tabs) {
      const id = String(t.tabId).padEnd(idWidth);
      const title = (t.title || '').substring(0, 54).padEnd(54);
      console.log(`${id}  ${title}  ${t.url}`);
    }
    return;
  }

  if (!NEEDS_TAB.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const tabPrefix = args[0];
  if (!tabPrefix) {
    console.error('Error: tab ID required. Run "tab-control list" first.');
    process.exit(1);
  }

  const tabs = loadSharedTabs();
  const tabId = resolveTabId(tabPrefix, tabs);
  const socketPath = `${SOCK_PREFIX}${tabId}.sock`;

  if (!existsSync(socketPath)) {
    console.error(`Socket not found for tab ${tabId}. Is the extension running?`);
    process.exit(1);
  }

  const cdp = new CdpSocket();
  try {
    await cdp.connect(socketPath);
  } catch (e) {
    console.error(`Cannot connect to tab ${tabId}: ${e.message}`);
    process.exit(1);
  }

  const cmdArgs = args.slice(1);

  try {
    let result;
    switch (cmd) {
      case 'snap': case 'snapshot': result = await snapshotStr(cdp); break;
      case 'annotations': result = await annotationsStr(cdp); break;
      case 'pins': result = await picksStr(cdp); break;
      case 'eval': {
        const expr = cmdArgs.join(' ');
        if (!expr) { console.error('Error: expression required'); process.exit(1); }
        result = await evalStr(cdp, expr);
        break;
      }
      case 'shot': case 'screenshot': result = await shotStr(cdp, cmdArgs[0]); break;
      case 'html': result = await htmlStr(cdp, cmdArgs[0]); break;
      case 'nav': case 'navigate': {
        if (!cmdArgs[0]) { console.error('Error: URL required'); process.exit(1); }
        result = await navStr(cdp, cmdArgs[0]);
        break;
      }
      case 'net': case 'network': result = await netStr(cdp); break;
      case 'console': result = await consoleStr(cdp, cmdArgs[0] ? parseInt(cmdArgs[0]) : 5); break;
      case 'requests': result = await requestsStr(cdp, cmdArgs[0] ? parseInt(cmdArgs[0]) : 5); break;
      case 'watch': result = await watchStr(cdp, cmdArgs[0] ? parseInt(cmdArgs[0]) : 10); break;
      case 'click': result = await clickStr(cdp, cmdArgs[0]); break;
      case 'clickxy': result = await clickXyStr(cdp, cmdArgs[0], cmdArgs[1]); break;
      case 'type': {
        const text = cmdArgs.join(' ');
        if (!text) { console.error('Error: text required'); process.exit(1); }
        result = await typeStr(cdp, text);
        break;
      }
      case 'loadall': result = await loadAllStr(cdp, cmdArgs[0], cmdArgs[1] ? parseInt(cmdArgs[1]) : 1500); break;
      case 'evalraw': {
        if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
        const jsonParams = cmdArgs.length > 2 ? cmdArgs.slice(1).join(' ') : cmdArgs[1];
        result = await evalRawStr(cdp, cmdArgs[0], jsonParams);
        break;
      }
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

main().catch((e) => { console.error(e.message); process.exit(1); });
