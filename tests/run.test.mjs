// End-to-end tests for `tab-control run`: a script of many steps against one
// shared tab in a single CLI call, through the real proxy and a fake extension.
//
// The fake extension answers Runtime.evaluate with "tab <id> evaluated <expr>"
// and any other CDP method with {echo: <method>, tabId}. No browser needed.
//
// Run: make test   (or: node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { TAB, withTimeout, until, withProxy, runCli, runCliWithStdin } from './helpers.mjs';

const evaluated = (expr) => `tab ${TAB.tabId} evaluated ${expr}`;

// Writes the script into the test's temp HOME and runs it.
function runScript(home, source, extraArgs = []) {
  const file = `${home}/script.js`;
  writeFileSync(file, source);
  return runCli(home, ['run', TAB.handle, file, ...extraArgs]);
}

const evaluateCount = (ext) => ext.cdpCommands().filter((m) => m.method === 'Runtime.evaluate').length;

test('run executes several steps against the tab and prints the returned value', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runScript(home, `
      const sum = await tab.eval('1+1');
      const doc = await tab.cdp('DOM.getDocument');
      return { sum, method: doc.echo, tabId: doc.tabId };
    `);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { sum: evaluated('1+1'), method: 'DOM.getDocument', tabId: TAB.tabId });
  });
});

test('run reads the script from stdin when no file is given', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runCliWithStdin(home, ['run', TAB.handle], "return await tab.eval('document.title');");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), evaluated('document.title'));
  });
});

test('run sends a function to the page with its args JSON-encoded', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runScript(home, "return await tab.eval((sel, n) => sel + n, 'a\"b', 2);");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), evaluated('((sel, n) => sel + n)("a\\"b", 2)'));
  });
});

test('run prints console.log output from the script, then the returned value', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runScript(home, "console.log('step 1 done');\nreturn 'finished';");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'step 1 done\nfinished\n');
  });
});

test('run prints nothing extra when the script returns nothing', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runScript(home, "await tab.eval('1');");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
  });
});

test('run names the script line of a runtime error and exits non-zero', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runScript(home, "await tab.eval('1');\nconst x = null;\nx.missing;\n");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Cannot read properties of null.*\(script line 3\)/);
  });
});

test('run names the script line of an error thrown by a tab method', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runScript(home, "await tab.eval('1');\nawait tab.key('NoSuchKey');\n");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown key "nosuchkey".*\(script line 2\)/);
  });
});

test('run reports a syntax error with its line and never touches the tab', async () => {
  await withProxy([TAB], async ({ home, ext }) => {
    const r = await runScript(home, "await tab.eval('1');\nfoo(;\n");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SyntaxError: .*\(script line 2\)/);
    assert.equal(evaluateCount(ext), 0);
  });
});

test('run stops a script that outlives --timeout', async () => {
  await withProxy([TAB], async ({ home }) => {
    const started = Date.now();
    const r = await runScript(home, 'await sleep(30000);', ['--timeout', '0.5']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did not finish within 0\.5s/);
    assert.ok(Date.now() - started < 10_000);
  });
});

test('run stops with an error as soon as its tab is unshared mid-script', async () => {
  await withProxy([TAB], async ({ home, ext }) => {
    const file = `${home}/loop.js`;
    writeFileSync(file, "while (true) {\n  await tab.eval('poll');\n  await sleep(20);\n}\n");
    const run = runCli(home, ['run', TAB.handle, file]);
    await until(() => evaluateCount(ext) > 0, 'script to start');
    await ext.unshare(TAB.tabId);
    const r = await withTimeout(run, 'run to exit');
    assert.equal(r.code, 1);
    // The error is raised by the socket, not the script; the call site names the line.
    assert.match(r.stderr, /Disconnected from the tab.*\(script line 2\)/);
  });
});

test('run refuses an empty script instead of silently doing nothing', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runCliWithStdin(home, ['run', TAB.handle], '  \n');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /script is empty/);
  });
});

test('run rejects a script file that does not exist', async () => {
  await withProxy([TAB], async ({ home }) => {
    const r = await runCli(home, ['run', TAB.handle, `${home}/missing.js`]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ENOENT/);
  });
});
