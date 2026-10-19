---
name: chrome-tab-control
description: Control user-shared Chrome tabs — take screenshots, inspect accessibility trees, evaluate JS, navigate, click elements, type text, and monitor console/network activity in real time
---

# Chrome Tab Control

Control Chrome tabs that the user has explicitly shared via the Tab Control extension. No `--remote-debugging-port` flag needed — the extension uses Chrome's debugger API directly.

## Prerequisites

- The Tab Control Chrome extension must be installed and the user must have shared at least one tab
- Node.js 22+

## How It Works

1. User clicks the Tab Control extension icon in Chrome (or right-clicks the page)
2. User clicks "Share" next to the tab they want to expose
3. The extension creates a random **tab handle** for that tab, e.g. `K7QM-4XRT-AB12`, and copies it to the user's clipboard; the user pastes it to you
4. You pass the handle wherever a command takes `<tab>`
5. User clicks "Unshare" when done — the handle stops working

Shared tabs are **never listed**: there is no way to discover them. The tab handle is the only way to reach a tab, and the user decides who gets it.

## Commands

All commands use `scripts/tab-control-cli.mjs`. The `<tab>` argument is the tab handle the user gave you.

### Get the tab handle

If the user has not given you a tab handle, ask: *"Please share the tab with Tab Control and paste me its tab handle (sharing copies it to your clipboard; the extension popup also shows it)."* Do not guess one, and do not look for a way to list tabs (`list` is disabled on purpose).

Never read the clipboard yourself to get the handle (no `pbpaste`, `osascript`, `xclip` or similar), even though sharing copies it there: the clipboard may hold unrelated private data. Wait for the user to paste it to you.

Treat the handle as a secret: do not write it to files, commits or logs.

### Check you have the right tab

```bash
scripts/tab-control-cli.mjs info <tab>    # prints the tab's title and URL
```

If a command reports `No shared tab has the handle`, the tab was unshared or the handle is wrong: ask the user for the current one.

### Take a screenshot

```bash
scripts/tab-control-cli.mjs shot <tab> [file]    # default: /tmp/screenshot.png
scripts/tab-control-cli.mjs shot <tab> [file] --highlight <selector>  # highlight matching elements
```

The `--highlight` flag draws a red overlay on all elements matching the CSS selector before taking the screenshot. Useful for confirming which elements exist and where they are on the page.

### Accessibility tree snapshot

```bash
scripts/tab-control-cli.mjs snap <tab>
```

### Get user annotations

The user can draw annotations (circles, rectangles, arrows, text) on shared tabs to visually communicate with the agent. Use this command to get structured data about all annotations, including the page elements they point to.

```bash
scripts/tab-control-cli.mjs annotations <tab>
```

Output example:
```
[circle] red center=(150,200) rx=80 ry=60 -> button#submit "Submit Form"
[arrow] red from=(50,300) to=(150,200)
[text] red at=(160,180) text="fix this button"
```

When the user says "look at what I circled" or "check my annotations", use `annotations` to understand what they marked, then use `shot` to see the visual context.

### Get selected elements

The user can use Select (right-click > Select, or `Cmd+Shift+E`) to hover over page elements and click to pin them. This is more precise than annotations for identifying specific DOM elements. Use this command to get the selected elements:

```bash
scripts/tab-control-cli.mjs pins <tab>
```

Output example:
```
#1 button#submit.btn.primary at=(200,400) size=120x36 "Submit Form"
#2 input[type="email"][name="user_email"].form-input at=(200,350) size=300x32 "user@example.com"
```

When the user mentions "selected elements", "pinned elements", "my pins", or "elements I selected", they all refer to the same thing — use `pins` to retrieve them.

### Evaluate JavaScript

```bash
scripts/tab-control-cli.mjs eval <tab> <expr>
```

### Other commands

```bash
scripts/tab-control-cli.mjs annotations <tab>             # list user annotations with page context
scripts/tab-control-cli.mjs pins <tab>                   # list user-selected elements
scripts/tab-control-cli.mjs html    <tab> [selector]    # full page or element HTML
scripts/tab-control-cli.mjs nav     <tab> <url>          # navigate and wait for load (same-host only)
scripts/tab-control-cli.mjs nav     <tab> <url> --watch [sec]  # navigate with console+network monitoring
scripts/tab-control-cli.mjs nav     <tab> <url> --cross-origin  # allow navigation to a different host
scripts/tab-control-cli.mjs refresh <tab> [--hard]       # reload current URL (--hard bypasses cache)
scripts/tab-control-cli.mjs net     <tab>                # resource timing entries
scripts/tab-control-cli.mjs click   <tab> <selector>     # click element by CSS selector
scripts/tab-control-cli.mjs clickxy <tab> <x> <y>        # click at CSS pixel coordinates
scripts/tab-control-cli.mjs type    <tab> <text>          # type text at current focus
scripts/tab-control-cli.mjs loadall <tab> <selector> [ms] # click until element disappears
scripts/tab-control-cli.mjs evalraw <tab> <method> [json] # raw CDP command
scripts/tab-control-cli.mjs console <tab> [seconds]       # monitor console output (default 5s)
scripts/tab-control-cli.mjs console <tab> --history       # show buffered console/log entries
scripts/tab-control-cli.mjs console <tab> --clear        # clear console history buffer
scripts/tab-control-cli.mjs requests <tab> [seconds]      # monitor network requests (default 5s)
scripts/tab-control-cli.mjs watch <tab> [seconds]         # monitor console + network together (default 10s)
scripts/tab-control-cli.mjs key <tab> <key> [count]       # press a key (Enter, Shift+Enter, Escape, Tab...)
scripts/tab-control-cli.mjs waitfor <tab> <js-expr>       # wait until a JS expression is truthy
scripts/tab-control-cli.mjs front <tab>                   # bring tab to foreground (user activation)
```

### Focus and fill inputs

```bash
scripts/tab-control-cli.mjs focus <tab> <selector>
scripts/tab-control-cli.mjs fill  <tab> <selector> <text>
```

**Use `fill` rather than `click` + `type` for text entry.** A synthetic click does
not move focus to a `contenteditable` (rich-text editors, chat composers), so
`click` then `type` silently types into nothing. `fill` focuses the element —
falling back to real mouse events when `.focus()` is refused — selects any existing
content so the text is *replaced* rather than appended, inserts the text, and then
verifies it actually landed, failing loudly if it did not.

### Bring a tab to the foreground

```bash
scripts/tab-control-cli.mjs front <tab>
```

**Chrome grants transient user activation to CDP-dispatched input only while the
tab is in the foreground.** Any site action gated behind a user gesture — sending
a message, uploading a file, opening a file picker, clipboard access, popups —
is therefore **accepted and silently ignored** in a background tab: no error, no
console message, no network request. It looks exactly like a hang.

Diagnose it directly, then fix it:

```bash
scripts/tab-control-cli.mjs eval  <tab> "navigator.userActivation.isActive"   # false right after a click => this
scripts/tab-control-cli.mjs front <tab>                                       # then retry the click
```

`front` necessarily switches the user's visible tab, so only use it when an action
actually needs a gesture. It exits non-zero if the tab is still not visible
afterwards (minimised window), rather than reporting a success the page will not honour.

### Press keys

`type` uses `Input.insertText`, which inserts characters without producing key
events — it can never submit a form or fire a keyboard shortcut. Use `key` for that.

```bash
scripts/tab-control-cli.mjs key <tab> Enter
scripts/tab-control-cli.mjs key <tab> Shift+Enter      # newline instead of submit
scripts/tab-control-cli.mjs key <tab> Escape
scripts/tab-control-cli.mjs key <tab> Down 3           # press a key repeatedly
```

Modifiers: `alt`, `ctrl`, `cmd`/`meta`, `shift`.

### Wait for a condition

Polls from the CLI, so the wait is not limited by the 15s per-command CDP timeout.

```bash
scripts/tab-control-cli.mjs waitfor <tab> "document.querySelector('.results')"
scripts/tab-control-cli.mjs waitfor <tab> "window.done === true" --timeout 120 --interval 500
```

`--timeout` is in seconds (default 60), `--interval` in milliseconds (default 250).
It exits non-zero on timeout, so it is safe to chain with `&&`.

## Coordinates

`shot` saves at native resolution (CSS pixels x DPR). CDP Input events (`clickxy`) use CSS pixels.

```
CSS px = screenshot image px / DPR
```

## Tips

- Run `info <tab>` first to confirm the handle points at the page the user means.
- If you have no tab handle, ask the user to share the tab and send you its handle.
- The yellow "debugging this tab" bar is expected — it confirms the tab is shared.
- Prefer `snap` over `html` for understanding page structure.
- Use `type` (not eval) to enter text in cross-origin iframes.
- If the user drew annotations on the page, run `annotations` to get structured data about what they marked and which page elements are under each annotation.
- Combine `annotations` + `shot` to fully understand what the user is pointing at.
- Use `pins` when the user has selected specific elements — it gives exact selectors, positions, and text content.
- Use `nav <tab> <url> --watch` to capture console errors and network activity during page load — this is the best way to debug pages that break on load.
- `nav` is restricted to the tab's current hostname by default; this protects the user's trust boundary on the shared tab. To go to a different host, the user (or the agent with explicit user consent) must pass `--cross-origin`. Prefer `refresh` when you only need to reload the current page.
- Use `shot <tab> --highlight <selector>` to visually confirm which elements match a selector before interacting with them.
- `click` reports what it actually clicked. If the CSS selector matches a non-clickable wrapper (common with Angular/React custom elements, where the stable `data-test-id` sits on the wrapper), it automatically clicks the interactive `<a>`/`<button>` inside it and says so. Pass `--exact` to suppress that, or `--real` to use real mouse events when a synthetic `.click()` is ignored.
- Prefer `waitfor` over sleeping or repeated `eval` polling — it fails loudly with a timeout instead of silently continuing too early.
- **Extract text with `textContent`, not `innerText`.** A shared tab is usually in the background, where Chrome throttles animations and timers. `innerText` returns only *rendered* text, so on any site that animates content in, it lags badly or stays empty — measured on Gemini: `textContent` held the full 242-character answer at 3s while `innerText` showed 67 characters and then froze entirely once the tab went hidden. Reading `innerText` there silently yields a *truncated* answer, not an obviously broken one. Use `textContent` and rebuild line breaks from block elements if structure matters.
- Check `document.visibilityState` when a page seems frozen or content never arrives — a hidden tab behaves very differently from the one the user is looking at.
- Use `console <tab> --history` to check for errors that already occurred before you started monitoring — useful when a page is already broken.
