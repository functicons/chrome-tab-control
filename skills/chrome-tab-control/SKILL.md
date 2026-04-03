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
scripts/tab-control-cli.mjs nav     <tab> <url>          # navigate and wait for load
scripts/tab-control-cli.mjs nav     <tab> <url> --watch [sec]  # navigate with console+network monitoring
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
- If the user drew annotations on the page, run `annotations` to get structured data about what they marked and which page elements are under each annotation.
- Combine `annotations` + `shot` to fully understand what the user is pointing at.
- Use `pins` when the user has selected specific elements — it gives exact selectors, positions, and text content.
- Use `nav <tab> <url> --watch` to capture console errors and network activity during page load — this is the best way to debug pages that break on load.
- Use `shot <tab> --highlight <selector>` to visually confirm which elements match a selector before interacting with them.
- Use `console <tab> --history` to check for errors that already occurred before you started monitoring — useful when a page is already broken.
