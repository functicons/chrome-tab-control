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

1. User clicks the Tab Control extension icon in Chrome
2. User clicks "Share" next to the tab(s) they want to expose
3. A yellow debugging bar appears on shared tabs (confirms sharing is active)
4. This CLI can now interact with those tabs
5. User clicks "Unshare" when done — the debugging bar disappears

## Commands

All commands use `scripts/tab-control-cli.mjs`. The `<tab>` argument is a tab ID from `list` (or a unique prefix).

### List shared tabs

```bash
scripts/tab-control-cli.mjs list
```

### Take a screenshot

```bash
scripts/tab-control-cli.mjs shot <tab> [file]    # default: /tmp/screenshot.png
```

### Accessibility tree snapshot

```bash
scripts/tab-control-cli.mjs snap <tab>
```

### Evaluate JavaScript

```bash
scripts/tab-control-cli.mjs eval <tab> <expr>
```

### Other commands

```bash
scripts/tab-control-cli.mjs html    <tab> [selector]    # full page or element HTML
scripts/tab-control-cli.mjs nav     <tab> <url>          # navigate and wait for load
scripts/tab-control-cli.mjs net     <tab>                # resource timing entries
scripts/tab-control-cli.mjs click   <tab> <selector>     # click element by CSS selector
scripts/tab-control-cli.mjs clickxy <tab> <x> <y>        # click at CSS pixel coordinates
scripts/tab-control-cli.mjs type    <tab> <text>          # type text at current focus
scripts/tab-control-cli.mjs loadall <tab> <selector> [ms] # click until element disappears
scripts/tab-control-cli.mjs evalraw <tab> <method> [json] # raw CDP command
scripts/tab-control-cli.mjs console <tab> [seconds]       # monitor console output (default 5s)
scripts/tab-control-cli.mjs requests <tab> [seconds]      # monitor network requests (default 5s)
scripts/tab-control-cli.mjs watch <tab> [seconds]         # monitor console + network together (default 10s)
```

## Coordinates

`shot` saves at native resolution (CSS pixels x DPR). CDP Input events (`clickxy`) use CSS pixels.

```
CSS px = screenshot image px / DPR
```

## Tips

- Run `list` first to see which tabs the user has shared.
- If no tabs are shared, ask the user to open the Tab Control extension and share a tab.
- The yellow "debugging this tab" bar is expected — it confirms the tab is shared.
- Prefer `snap` over `html` for understanding page structure.
- Use `type` (not eval) to enter text in cross-origin iframes.
