// Unit tests for the pure argument-parsing logic in tab-control-cli.mjs.
//
// Everything else in the CLI needs a live Chrome tab, but these parsers are pure
// and are exactly where silent misbehaviour is cheapest to introduce.
//
// Run: make test   (or: node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/chrome-tab-control/scripts/tab-control-cli.mjs');
const { parseKeySpec, parseRepeat, parseWaitForArgs } = await import(pathToFileURL(CLI).href);

// --- parseKeySpec -----------------------------------------------------------

test('parseKeySpec resolves a bare key case-insensitively', () => {
  for (const spec of ['Enter', 'enter', 'ENTER']) {
    const { def, modifiers, label } = parseKeySpec(spec);
    assert.equal(def.key, 'Enter');
    assert.equal(def.keyCode, 13);
    assert.equal(modifiers, 0);
    assert.equal(label, 'Enter');
  }
});

test('parseKeySpec combines modifier bits (alt=1, ctrl=2, meta=4, shift=8)', () => {
  assert.equal(parseKeySpec('Shift+Enter').modifiers, 8);
  assert.equal(parseKeySpec('Ctrl+Enter').modifiers, 2);
  assert.equal(parseKeySpec('Cmd+Enter').modifiers, 4);
  assert.equal(parseKeySpec('Alt+Enter').modifiers, 1);
  assert.equal(parseKeySpec('Ctrl+Shift+Enter').modifiers, 10);
});

test('parseKeySpec treats cmd/meta/command and ctrl/control as synonyms', () => {
  const meta = parseKeySpec('Meta+Enter').modifiers;
  assert.equal(parseKeySpec('Cmd+Enter').modifiers, meta);
  assert.equal(parseKeySpec('Command+Enter').modifiers, meta);
  assert.equal(parseKeySpec('Control+Enter').modifiers, parseKeySpec('Ctrl+Enter').modifiers);
});

test('parseKeySpec keeps the modifiers in the printable label', () => {
  assert.equal(parseKeySpec('Shift+Enter').label, 'Shift+Enter');
  assert.equal(parseKeySpec('Ctrl+Shift+Enter').label, 'Ctrl+Shift+Enter');
});

test('parseKeySpec rejects unknown keys and modifiers by name', () => {
  assert.throws(() => parseKeySpec('Bogus'), /Unknown key "bogus"/);
  assert.throws(() => parseKeySpec('Hyper+Enter'), /Unknown modifier "Hyper"/);
  assert.throws(() => parseKeySpec(''), /key required/);
  assert.throws(() => parseKeySpec(undefined), /key required/);
});

test('parseKeySpec only gives a text payload to character-producing keys', () => {
  assert.equal(parseKeySpec('Enter').def.text, '\r');
  assert.equal(parseKeySpec('Tab').def.text, '\t');
  assert.equal(parseKeySpec('Escape').def.text, undefined);
  assert.equal(parseKeySpec('Backspace').def.text, undefined);
});

// --- parseRepeat ------------------------------------------------------------

test('parseRepeat defaults to a single press for absent or junk values', () => {
  assert.equal(parseRepeat(undefined), 1);
  assert.equal(parseRepeat(null), 1);
  assert.equal(parseRepeat('--real'), 1);   // a flag, not a count
  assert.equal(parseRepeat('0'), 1);
  assert.equal(parseRepeat('-5'), 1);
});

test('parseRepeat accepts a positive count', () => {
  assert.equal(parseRepeat('3'), 3);
  assert.equal(parseRepeat(30), 30);
});

test('parseRepeat refuses counts that would block for minutes', () => {
  assert.equal(parseRepeat('500'), 500);
  assert.throws(() => parseRepeat('501'), /exceeds the maximum/);
  assert.throws(() => parseRepeat('100000'), /exceeds the maximum/);
});

// --- parseWaitForArgs -------------------------------------------------------

test('parseWaitForArgs applies documented defaults', () => {
  const { expression, timeoutMs, intervalMs } = parseWaitForArgs(['window.ready']);
  assert.equal(expression, 'window.ready');
  assert.equal(timeoutMs, 60000);
  assert.equal(intervalMs, 250);
});

test('parseWaitForArgs reads --timeout in seconds and --interval in milliseconds', () => {
  const r = parseWaitForArgs(['window.ready', '--timeout', '120', '--interval', '500']);
  assert.equal(r.timeoutMs, 120000);
  assert.equal(r.intervalMs, 500);
  assert.equal(r.expression, 'window.ready');
});

test('parseWaitForArgs accepts a fractional timeout', () => {
  assert.equal(parseWaitForArgs(['x', '--timeout', '1.5']).timeoutMs, 1500);
});

test('parseWaitForArgs strips flags from the expression regardless of position', () => {
  const r = parseWaitForArgs(['--timeout', '5', 'document.title', '=== "x"']);
  assert.equal(r.expression, 'document.title === "x"');
  assert.equal(r.timeoutMs, 5000);
});

test('parseWaitForArgs rejects non-positive and non-numeric flag values', () => {
  assert.throws(() => parseWaitForArgs(['x', '--timeout', '0']), /positive number of seconds/);
  assert.throws(() => parseWaitForArgs(['x', '--timeout', 'abc']), /positive number of seconds/);
  assert.throws(() => parseWaitForArgs(['x', '--interval', '-1']), /positive number of milliseconds/);
});

test('parseWaitForArgs returns an empty expression when only flags are given', () => {
  assert.equal(parseWaitForArgs(['--timeout', '5']).expression, '');
  assert.equal(parseWaitForArgs([]).expression, '');
});
