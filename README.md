# 🤖 Chrome Tab Control

**Give your AI agent eyes and hands on your browser — one tab at a time.**

A Chrome extension + CLI + AI skill that lets you selectively share browser tabs with AI agents (like Claude Code) for real-time inspection, interaction, and debugging. Install the skill, share a tab, and let your AI agent take it from there.

## ✨ Features

- 🔒 **Per-tab access control** — only explicitly shared tabs are accessible
- 📸 **Screenshots** — capture viewport with coordinate mapping
- 🌳 **Accessibility tree** — structured page snapshot for AI understanding
- ⌨️ **Interaction** — click elements, type text, navigate pages
- 🔍 **Console monitoring** — capture `console.log`, errors, warnings in real time
- 🌐 **Network monitoring** — watch requests/responses with POST bodies
- 👁️ **Visual indicator** — shared tabs show flashing ⚪🟡 in the tab title
- 🖱️ **Right-click to share** — share/unshare from the page context menu
- ✏️ **Annotation overlay** — draw circles, rectangles, arrows, and text on shared tabs to communicate with the agent
- 🚀 **Zero npm dependencies** — uses Node.js 22+ built-ins only

## 🤔 Why Chrome Tab Control?

There are other ways to connect AI agents to Chrome. Here's how they compare:

| | Chrome Tab Control | [chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) | [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | [Claude in Chrome](https://code.claude.com/docs/en/chrome) |
|---|---|---|---|---|
| **Control existing tabs** | ✅ Shared tabs only | ✅ All tabs | ✅ All tabs | ❌ Opens new tabs |
| **Per-tab access control** | ✅ User chooses | ❌ All tabs exposed | ❌ All tabs exposed | N/A |
| **No `--remote-debugging-port`** | ✅ Not needed | ❌ Required | ❌ Required | ✅ Not needed |
| **Console/network monitoring** | ✅ Real-time streaming | ❌ No | ✅ Via MCP tools | ❌ No |
| **Works with any AI agent** | ✅ Any CLI-capable agent | ✅ Any CLI-capable agent | ✅ Any MCP client | ❌ Claude only |
| **npm dependencies** | None | None | Yes | N/A (extension) |
| **Setup complexity** | Extension + one command | Enable debug port | Debug port + npm install | Extension only |

### The problem with `--remote-debugging-port`

Chrome DevTools MCP and chrome-cdp-skill require Chrome to be launched with a special flag or remote debugging enabled. This **exposes every tab** — your banking site, your email, your private messages — to any process that connects to the debug port. It's a security risk that most developers are uncomfortable with.

### The problem with new-tab-only

Claude in Chrome opens fresh tabs for tasks. But often you want your AI agent to work with a page you're *already looking at* — debug a form that's misbehaving, extract data from a dashboard, or monitor network requests while you interact with the page.

### Chrome Tab Control: the best of both worlds

Share only the tabs you want. Your agent sees what you allow, nothing more. No debug port, no new tabs — just point at a tab and say "help me with this."

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
3. 🔌 **Tab proxy** creates a Unix socket for the tab
4. 🤖 **AI agent** reads the skill, discovers shared tabs, and runs CLI commands
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
make check
```

## 🚀 Usage

### Share a tab

Three ways to share a tab:
1. Click the 🤖 extension icon → click **Share** next to the tab
2. Right-click anywhere on the page → **Share Tab**
3. Use the keyboard shortcut to toggle annotation (which requires sharing first)

The tab title will show a flashing ⚪🟡 indicator confirming it's shared.

### Annotate a tab

Draw on a shared tab to visually communicate with the AI agent. Annotations appear in CDP screenshots, so the agent sees exactly what you marked up.

**Activate annotation mode** (3 ways):
1. Click the 🤖 extension icon → click **Annotate** next to a shared tab
2. Right-click on a shared tab → **Annotate Tab**
3. Press `Cmd+Shift+A` (Mac) / `Ctrl+Shift+A` (Windows/Linux)

**Drawing tools** (floating toolbar or keyboard shortcuts):
| Tool | Toolbar | Key | How to draw |
|---|---|---|---|
| Circle | ○ | `C` | Click and drag to define bounding box |
| Rectangle | □ | `R` | Click and drag to define bounding box |
| Arrow | → | `A` | Click and drag from start to end |
| Text | T | `T` | Click to place, type text, Enter to confirm |

**Colors:** 6 colors available in the toolbar (red, blue, green, orange, purple, black). Switch via click or number keys `1`–`6`.

**Other controls:**
| Action | Toolbar | Key |
|---|---|---|
| Undo | ↩ | `Cmd+Z` / `Ctrl+Z` |
| Clear all | ✕ | — |
| Exit annotation | ✓ | `Esc` (press twice: first deselects tool, second exits) |

### 🤖 Use with AI agents (Claude Code)

Once the skill is installed (`make install-skill`), share a tab and ask Claude Code to work with it. Examples:

```
"Summarize the page I'm looking at"
"Extract all the links from this page"
"Check the console for errors"
"Monitor network requests while I click around"
"Take a screenshot and describe the layout"
"Click the login button and fill in the form"
"What API calls is this page making?"
```

Claude Code will automatically discover shared tabs and use the CLI to interact with them.

### CLI commands

```bash
# Alias for convenience
alias tc='node skills/chrome-tab-control/scripts/tab-control-cli.mjs'

# List shared tabs
tc list

# Take a screenshot
tc shot <tab>              # saves to /tmp/screenshot.png

# Accessibility tree snapshot (best for AI understanding)
tc snap <tab>

# Evaluate JavaScript
tc eval <tab> "document.title"

# Navigate
tc nav <tab> https://example.com

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

# Monitor network requests (real-time)
tc requests <tab> 30

# Monitor both console + network together
tc watch <tab> 60          # great for debugging interactions

# Send raw CDP command
tc evalraw <tab> "DOM.getDocument" "{}"
```

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
│   ├── annotate.js                        # Annotation overlay (injected on demand)
│   └── icons/
├── scripts/                            # Setup & dev tools
│   ├── install-tab-proxy.sh            # Tab proxy setup
│   ├── install-skill.sh                # Install as Claude Code skill
│   ├── check.sh                        # Verify dependencies
│   └── gen-icons.mjs                   # Icon generator
└── skills/chrome-tab-control/          # Skill directory (what AI agents use)
    ├── SKILL.md                        # Skill manifest
    └── scripts/
        ├── tab-control-cli.mjs         # CLI tool (all commands)
        ├── tab-proxy.mjs             # Tab proxy (native messaging bridge)
        └── tab-proxy-wrapper.sh      # Node.js path resolver for nvm/volta/fnm
```

### Data flow

**CLI → Agent:** Unix socket (NDJSON) → tab-proxy.mjs → stdin/stdout (native messaging) → extension → `chrome.debugger.sendCommand()` → Chrome

**Chrome → CLI (events):** Chrome → `chrome.debugger.onEvent` → extension → native messaging → tab-proxy.mjs → broadcasts to all connected sockets

### Key design decisions

- **No `--remote-debugging-port`** — the extension uses `chrome.debugger` API, which is scoped to individual tabs
- **Per-tab Unix sockets** — each shared tab gets its own socket at `/tmp/chrome-tab-control/tab-<tabId>.sock`
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
- Unix sockets are `chmod 600` (owner-only)
- Extension requires explicit user action to share each tab

## 📄 License

MIT
