# 🤖 Chrome Tab Control

**Give your AI agent eyes and hands on your browser — one tab at a time.**

A Chrome extension + CLI + AI skill that lets you selectively share browser tabs with AI agents (like Claude Code) for real-time inspection, interaction, and debugging. Install the skill, share a tab, and let your AI agent take it from there.

## ✨ Features

- 🔒 **Per-tab access control** — only explicitly shared tabs are accessible
- 🌐 **Remote hosts** — let an agent on another machine (over SSH) reach the tabs you choose, with a per-tab **Remote** switch
- 🔑 **Secret tab handles** — shared tabs are never listed; each gets a random handle, and only agents you give it to can reach the tab
- 📸 **Screenshots** — capture viewport with coordinate mapping
- 🌳 **Accessibility tree** — structured page snapshot for AI understanding
- ⌨️ **Interaction** — click elements, type text, navigate pages
- 🔍 **Console monitoring** — capture `console.log`, errors, warnings in real time, with history buffer
- 🌐 **Network monitoring** — watch requests/responses with POST bodies
- 🧭 **Navigate + watch** — monitor console and network during page load in a single command
- 👁️ **Visual indicator** — shared tabs show flashing ⚪🟡 in the tab title
- 🖱️ **Right-click to share** — share/unshare from the page context menu
- ✏️ **Annotation** — draw circles, rectangles, arrows, and text to communicate with the agent
- 🎯 **Element selector** — hover and click to pin specific DOM elements for the agent to inspect
- 📷 **Screenshot** — select an area, resize, and save to disk (`Cmd+Shift+S`)
- 📋 **Extract text** — drag-select an area to copy all visible text within it
- 🚀 **Zero npm dependencies** — uses Node.js 22+ built-ins only

## 🤔 Why Chrome Tab Control?

There are other ways to connect AI agents to Chrome. Here's how they compare:

| | Chrome Tab Control | [chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) | [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | [Claude in Chrome](https://code.claude.com/docs/en/chrome) |
|---|---|---|---|---|
| **Control existing tabs** | ✅ Shared tabs only | ✅ All tabs | ✅ All tabs | ❌ Opens new tabs |
| **Per-tab access control** | ✅ User chooses | ❌ All tabs exposed | ❌ All tabs exposed | N/A |
| **No `--remote-debugging-port`** | ✅ Not needed | ❌ Required | ❌ Required | ✅ Not needed |
| **Annotation** | ✅ Draw on page | ❌ No | ❌ No | ❌ No |
| **Console/network monitoring** | ✅ Real-time streaming | ❌ No | ✅ Via MCP tools | ❌ No |
| **Works with any AI agent** | ✅ Any CLI-capable agent | ✅ Any CLI-capable agent | ✅ Any MCP client | ❌ Claude only |
| **npm dependencies** | None | None | Yes | N/A (extension) |
| **Setup complexity** | Extension + one command | Enable debug port | Debug port + npm install | Extension only |

### The problem with `--remote-debugging-port`

Chrome DevTools MCP and chrome-cdp-skill require Chrome to be launched with a special flag or remote debugging enabled. This **exposes every tab** — your banking site, your email, your private messages — to any process that connects to the debug port. It's a security risk that most developers are uncomfortable with.

### The problem with new-tab-only

Claude in Chrome opens fresh tabs for tasks. But often you want your AI agent to work with a page you're *already looking at* — debug a form that's misbehaving, extract data from a dashboard, or monitor network requests while you interact with the page.

### The problem with "just describe it"

With every other tool, you have to *describe* what you're looking at in words: "the button in the top-right corner", "the third row in the table", "that error message". It's slow, ambiguous, and frustrating — like a remote pair programming session without screen sharing.

### Chrome Tab Control: point, draw, and tell

Share only the tabs you want. **Draw directly on the page** — circle a bug, arrow to a button, type "fix this" next to a broken layout. Your agent sees the annotations in screenshots *and* can programmatically query what you're pointing at:

```
tc annotations <tab>
[rect] red at=(56,120) size=733x92
  -> span "Minor UI changes for noise filter monitoring"
  -> a[href="/dagang-w"] "dagang-w"
```

No debug port, no new tabs, no describing things in words — just point at your screen and say "help me with this."

## 🏗️ How It Works

```
┌─────────────────┐
│    AI Agent     │
│  (Claude Code)  │
└────────┬────────┘
         │ reads SKILL.md
         ▼
┌──────────────┐     ┌───────────────────┐     ┌──────────────────┐
│   CLI Tool   │     │    Tab Proxy      │     │ Chrome Extension │
│              │◄───►│                   │◄───►│                  │
│ tab-control  │Unix │  tab-proxy.mjs    │stdio│  background.js   │
│  -cli.mjs    │sock │                   │     │                  │
└──────────────┘     └───────────────────┘     └──────────────────┘
                                                       │
                                                       ▼
                                               chrome.debugger API
                                                       │
                                                       ▼
                                                ┌─────────────-┐
                                                │   Chrome     │
                                                │  (shared tab)│
                                                └─────────────-┘
```

1. 👤 **User** shares a tab (extension popup or right-click)
2. 🔗 **Extension** attaches `chrome.debugger` to that tab
3. 🔑 **Extension** generates a random tab handle (e.g. `K7QM-4XRT-AB12`) and copies it to your clipboard
4. 🤖 **AI agent** gets the handle when you paste it, attaches to the tab through the tab proxy's Unix socket, and runs CLI commands
5. ✅ Results flow back through the same chain

## 📦 Setup

### Prerequisites

- Node.js 22+
- Google Chrome

### 1. Install the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` directory

### 2. Install the tab proxy

```bash
make install-tab-proxy
```

### 3. Install as Claude Code skill (optional)

```bash
make install-skill
```

### 4. Verify setup

```bash
make check   # dependencies (Node, Chrome, tab proxy, skill)
make test    # unit tests for argument parsing (no browser needed)
```

## 🚀 Usage

### Share a tab

Two ways to share a tab:
1. Click the 🤖 extension icon → click **Share** next to the tab
2. Right-click anywhere on the page → **Share Tab**

The tab title will show a flashing ⚪🟡 indicator confirming it's shared.

### Give the tab handle to your agent

Shared tabs are never listed. Each shared tab gets a random **tab handle** such as `K7QM-4XRT-AB12`, and the handle is the only way to reach it:

- Sharing copies the handle to your clipboard (from the popup or the right-click menu), so you can paste it straight to your agent. The popup also lists it under the tab with a **Copy** button (the current tab is pinned to the top).
- Tell your agent the handle, e.g. *"use tab K7QM-4XRT-AB12"*. It uses the handle wherever a command takes `<tab>`: `tc snap K7QM-4XRT-AB12`. `tc info <tab>` prints the tab's title and URL, so the agent can check it has the right tab.
- The agent skill never reads your clipboard to find the handle, because the clipboard may hold unrelated private data. You paste it yourself.
- Unsharing retires the handle. Sharing the tab again creates a new one.

The handle lives only in the memory of the extension and the tab proxy; Chrome Tab Control never writes it to disk. It has 60 random bits, so it cannot practically be guessed. It keeps out every process you did not give it to, including other agent sessions. It does not stop malware already running as your user, which could read the handle wherever you paste it (e.g. an agent's session log).

### Annotate a tab

Draw on any tab to visually communicate with the AI agent. Annotations work independently of sharing — no need to share a tab first. On shared tabs, annotations appear in CDP screenshots and can be queried via `tc annotations`.

**Activate annotation mode** (3 ways):
1. Click the 🤖 extension icon → click **Annotate** next to any tab
2. Right-click on any page → **Annotate**
3. Press `Cmd+Shift+A` (Mac) / `Ctrl+Shift+A` (Windows/Linux)

**Drawing tools** (floating toolbar or keyboard shortcuts):
| Tool | Toolbar | Key | How to draw |
|---|---|---|---|
| Rectangle | □ | `R` | Click and drag to define bounding box |
| Circle | ○ | `C` | Click and drag to define bounding box |
| Arrow | → | `A` | Click and drag from start to end |
| Text | T | `T` | Click to place, type text, Enter to confirm |

**Moving annotations:** Click any annotation to select it (blue dashed outline), then drag to move. Press `Delete`/`Backspace` to remove the selected annotation. Works in any mode — no need to switch tools.

**Colors:** Click the color dot in the toolbar to open a picker with 6 colors (red, blue, green, orange, purple, black). Or press number keys `1`–`6`.

**Other controls:**
| Action | Toolbar | Key |
|---|---|---|
| Undo | ↩ | `Cmd+Z` / `Ctrl+Z` |
| Clear all | ✕ | — |
| Minimize toolbar | ▾ | `M` |
| Exit annotation | ✓ | `Esc` (press twice: first deselects tool, second exits) |

The toolbar is draggable (grab the `⠿` handle) and minimizable. Annotations persist after exiting — re-enter annotation mode to edit them.

### Select elements

Pin specific DOM elements so the AI agent knows exactly which elements you're referring to. More precise than annotations for targeting individual elements.

**Activate** (2 ways):
1. Right-click on any page → **Select**
2. Press `Cmd+Shift+E` (Mac) / `Ctrl+Shift+E` (Windows/Linux)

**Usage:**
1. Hover over elements — they highlight with a blue overlay and selector label
2. Click to **pin** an element (red highlight with numbered badge)
3. Click a pinned element again to **unpin** it
4. Pin as many elements as needed
5. Click **Done** or press `Esc` to exit — pins stay visible on the page

The agent can query pinned elements via `tc pins <tab>` to get exact selectors, positions, and text content.

### Extract text

Copy all visible text from a selected area — useful when elements are not easily selectable.

**Activate** (2 ways):
1. Right-click on any page → **Extract Text**
2. Press `Cmd+Shift+C` (Mac) / `Ctrl+Shift+C` (Windows/Linux)

**Usage:**
1. Drag to select a rectangular area
2. Text within the area is automatically copied to clipboard
3. A toast notification confirms the copied text

### Screenshot

Capture a selected area of any tab as a PNG image.

**Activate** (3 ways):
1. Click the 📷 button in the extension popup header
2. Right-click on any page → **Screenshot**
3. Press `Cmd+Shift+S` (Mac) / `Ctrl+Shift+S` (Windows/Linux)

**Usage:**
1. Drag to select an area (dimensions shown in pixels)
2. Resize using the 8 handles, or drag to reposition
3. Click **Capture** → Save As dialog appears
4. Press **Cancel** or `Esc` to dismiss

### 🤖 Use with AI agents (Claude Code)

Once the skill is installed (`make install-skill`), share a tab and give Claude Code its tab handle along with what you want. Examples:

```
"Summarize the page I'm looking at"
"Extract all the links from this page"
"Check the console for errors"
"Monitor network requests while I click around"
"Take a screenshot and describe the layout"
"Click the login button and fill in the form"
"What API calls is this page making?"
```

Claude Code will use the handle with the CLI to interact with the tab. If you forget the handle, it will ask for it.

### 🌐 Use from a remote host (SSH / remote sessions)

When your agent runs on another machine (over `ssh`, or a remote terminal session) but Chrome runs on your laptop, link the two:

1. In the extension popup, under **Remote hosts**, type the ssh destination (a host, `user@host`, or a `~/.ssh/config` alias) and click **Link**. The row turns **linked** within a few seconds.
2. Share the tab as usual. Sharing copies its handle.
3. Tick **Remote** next to the handle. It is off by default, so a shared tab stays local-only until you choose otherwise.
4. Paste the handle into the remote session. Your terminal is local, so the clipboard works as usual.

The remote agent uses the handle exactly as it would locally (`tc info <tab>`). Each host's row in the popup shows its state (`connecting`, `linked`, `retrying` with the reason) and its latest attaches and refusals, so you can see what reached your tabs. **Unlink** cuts the host off. Hosts you linked before stay listed as **not linked**, for one click to relink. Nothing links on its own, not even when Chrome starts.

A host can reach your tabs only while it is linked, a tab only with **Remote** ticked, and only with that tab's handle. Ticking **Remote** opens a tab to every linked host, but only a host whose agent has the handle can attach to it.

Links from the popup are **per Chrome profile**. Each profile runs its own copy of the extension and its own tab proxy, so a link started in one profile's popup reaches only that profile's tabs and is listed only in that popup. To use tabs from two profiles on the same host, link it from both. Links from the popup run inside the tab proxy, so they end when Chrome quits.

To link from a terminal instead, run `tc remote devbox` on the Chrome machine. A terminal link reaches the tabs of **every** profile (still only those with **Remote** ticked, and only by handle). It prints each attach and refusal, and Ctrl-C unlinks. Terminal links are not listed in any popup.

**How it works:** a link keeps an `ssh -R` session open that forwards `~/.chrome-tab-control/sock/remote-<laptop>.sock` on the remote host to a local bridge. The bridge marks each attach as remote and hands it to the local tab proxy, which admits it only for tabs with **Remote** ticked. Turning **Remote** off disconnects remote agents from that tab at once and keeps local ones. If the SSH connection drops, the link reconnects with backoff. Restarting Chrome does not break it.

**Requirements:**
- Key-based SSH from the laptop to the remote host. The link runs ssh with `BatchMode=yes`, so it cannot answer password prompts.
- Node.js 22+ and this skill installed on the remote host. No Chrome and no tab proxy are needed there.
- The ssh destination must take a POSIX-style shell command (bash, zsh or sh as the login shell).

### CLI commands

```bash
# Alias for convenience
alias tc='node skills/chrome-tab-control/scripts/tab-control-cli.mjs'

# <tab> is the tab handle (copied to your clipboard when you share), e.g. K7QM-4XRT-AB12
# Show the tab's title and URL
tc info <tab>

# Take a screenshot
tc shot <tab>              # saves to /tmp/screenshot.png
tc shot <tab> --highlight "button.primary"  # highlight matching elements

# Accessibility tree snapshot (best for AI understanding)
tc snap <tab>

# Evaluate JavaScript
tc eval <tab> "document.title"

# Navigate (same-host only by default)
tc nav <tab> https://example.com
tc nav <tab> https://example.com --watch       # monitor console+network during load
tc nav <tab> https://example.com --watch 5     # monitor for 5s after load
tc nav <tab> https://other.com --cross-origin  # opt in to cross-host navigation

# Reload the current page (no host change, no URL needed)
tc refresh <tab>
tc refresh <tab> --hard                       # bypass cache

# Click an element
tc click <tab> "button.submit"

# Click at coordinates (CSS pixels)
tc clickxy <tab> 200 300

# Type text at current focus
tc type <tab> "Hello world"

# Get page HTML
tc html <tab>              # full page
tc html <tab> ".sidebar"   # specific element

# Monitor console output (real-time)
tc console <tab> 30        # watch for 30 seconds
tc console <tab> --history # show all console output since tab was shared
tc console <tab> --clear   # clear console history buffer

# Monitor network requests (real-time)
tc requests <tab> 30

# Monitor both console + network together
tc watch <tab> 60          # great for debugging interactions

# List user-drawn annotations with underlying page elements
tc annotations <tab>

# List user-selected (pinned) elements
tc pins <tab>

# Focus / fill inputs (prefer fill over click+type for text entry)
tc focus <tab> "textarea.prompt"
tc fill  <tab> "textarea.prompt" "some text"   # focus + select-all + insert + verify

# Press a key (type cannot: it inserts text without key events)
tc key <tab> Enter
tc key <tab> Shift+Enter          # newline instead of submit
tc key <tab> Down 3               # repeat a key

# Wait for a page condition (not bound by the 15s per-command timeout)
tc waitfor <tab> "document.querySelector('.results')"
tc waitfor <tab> "window.ready === true" --timeout 120 --interval 500

# Bring tab to foreground (required for gesture-gated actions)
tc front <tab>

# Link this Chrome to a remote host (run on the Chrome machine; Ctrl-C to unlink)
tc remote devbox [--name <label>]

# Send raw CDP command
tc evalraw <tab> "DOM.getDocument" "{}"
```

## ⚠️ Foreground-only: user activation

The most expensive gotcha in this tool. Chrome grants **transient user activation**
to CDP-dispatched input *only while the tab is in the foreground*. Any site action
gated behind a user gesture — sending a message, uploading, opening a file picker,
clipboard access — is **accepted and silently ignored** in a background tab. No
error, no console message, no network request. It looks exactly like a hang, and is
easy to misdiagnose as rate limiting or an expired session.

```bash
tc eval  <tab> "navigator.userActivation.isActive"   # false right after a click => this bug
tc front <tab>                                       # bring it forward, then retry
```

`tc front` switches the user's visible tab, so reach for it only when the action
genuinely needs a gesture. It exits non-zero if the tab still is not visible
afterwards (a minimised window, or another desktop) rather than reporting a
success the page will not honour.

## ⚠️ Background tabs change what you can read

`innerText` reports only **rendered** text. Shared tabs are usually backgrounded,
where Chrome throttles animations, so on any site that animates content in,
`innerText` lags or stays empty while `textContent` is unaffected. Measured on one
chat UI: `textContent` held the complete 242-character answer at 3s, where
`innerText` showed 67 characters and then froze at 86 once the tab went hidden.

The failure is quiet — you get a **truncated** answer rather than an error. Extract
with `textContent` and rebuild line breaks from block elements if structure matters.

## 🔧 Architecture

### Files

```
chrome-tab-control/
├── README.md
├── LICENSE
├── Makefile
├── extension/                          # Chrome extension (user installs into Chrome)
│   ├── manifest.json
│   ├── background.js
│   ├── popup.html / popup.css / popup.js
│   ├── offscreen.html / offscreen.js       # Hidden page that copies the tab handle to the clipboard
│   ├── annotate.js                        # Annotation overlay (injected on demand)
│   ├── screenshot-select.js               # Screenshot area selector (injected on demand)
│   └── icons/
├── scripts/                            # Setup & dev tools
│   ├── install-tab-proxy.sh            # Tab proxy setup
│   ├── install-skill.sh                # Install as Claude Code skill
│   ├── check.sh                        # Verify dependencies
│   └── gen-icons.mjs                   # Icon generator
├── tests/                              # Unit tests (node --test, no deps)
│   ├── cli.test.mjs
│   ├── proxy.test.mjs                  # Proxy access control (spawns the real proxy)
│   ├── remote.test.mjs                 # Remote link: bridge, ssh supervisor (fake ssh)
│   ├── links.test.mjs                  # Links managed from the popup, via the proxy
│   ├── helpers.mjs                     # Shared harness: fake extension, socket client
│   └── fixtures/fake-ssh.mjs           # ssh stand-in with a local "remote host"
└── skills/chrome-tab-control/          # Skill directory (what AI agents use)
    ├── SKILL.md                        # Skill manifest
    └── scripts/
        ├── tab-control-cli.mjs         # CLI tool (all commands)
        ├── tab-proxy.mjs             # Tab proxy (native messaging bridge)
        ├── remote-link.mjs           # Remote link: bridge + ssh -R supervisor (`remote` command)
        ├── link-manager.mjs          # Links the tab proxy runs for the popup
        ├── protocol.mjs              # Paths and auth constants shared by CLI and proxy
        └── tab-proxy-wrapper.sh      # Node.js path resolver for nvm/volta/fnm
```

### Data flow

**CLI → Agent:** Unix socket (NDJSON) → tab-proxy.mjs → stdin/stdout (native messaging) → extension → `chrome.debugger.sendCommand()` → Chrome

**Remote CLI → Chrome:** remote-<name>.sock on the remote host → `ssh -R` → bridge-<id>.sock (remote-link.mjs; one per host and name) → proxy-<pid>.sock → … as above

**Chrome → CLI (events):** Chrome → `chrome.debugger.onEvent` → extension → native messaging → tab-proxy.mjs → sends to the sockets attached to that tab

### Key design decisions

- **No `--remote-debugging-port`** — the extension uses `chrome.debugger` API, which is scoped to individual tabs
- **Tab handles instead of tab IDs** — the tab proxy listens on one socket, `~/.chrome-tab-control/sock/proxy-<pid>.sock` (one proxy per Chrome profile). A client attaches to a tab by sending its handle, and the CLI tries each proxy socket until one accepts it. Nothing lists the shared tabs
- **Remote access over SSH, not a network listener** — a remote host reaches tabs only through a Unix socket forwarded by an `ssh -R` session that you started. The forwarded socket is named `remote-*.sock` so a tab proxy on the remote host never mistakes it for one of its own stale `proxy-<pid>.sock` files. sshd does not delete a forwarded socket when the link closes, so the link removes it before reconnecting
- **Zero dependencies** — pure Node.js 22+, no npm install needed
- **Tab proxy** acts as a reverse proxy between CLI clients and the Chrome extension

## 📊 Coordinate System

Screenshots are captured at native device resolution:

```
CSS pixels = screenshot pixels / DPR
```

The `shot` command prints the DPR and conversion formula. For Retina displays (DPR=2), divide screenshot coordinates by 2 for `clickxy`.

## 🛡️ Security

- Only tabs explicitly shared by the user are accessible
- CDP commands are validated against the shared tabs list
- Shared tabs are never listed. A client must attach with the tab's secret handle (see [Give the tab handle to your agent](#give-the-tab-handle-to-your-agent)) before it gets any command results or CDP events, and only for that tab
- Unix sockets are `chmod 600` inside `~/.chrome-tab-control/sock/`, which is `0700` and must be a real directory owned by you (the proxy refuses to start otherwise), so other accounts cannot reach or plant sockets
- Extension requires explicit user action to share each tab
- Remote access is off for every tab until you tick **Remote** for it, and it needs a running `tc remote` link that you started. The bridge, not the remote client, marks a request as remote, so a remote agent cannot pass itself off as local. The link carries only attach requests to the tab proxy, which checks the handle exactly as for a local client
- Anyone who can act as your user account on the remote host can use the forwarded socket while the link is up, and still needs a tab handle to reach a tab. Treat a handle you paste into a remote session as readable by that host

## 📄 License

MIT
