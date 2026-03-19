# 🤖 Chrome Tab Control

**Give your AI agent eyes and hands on your browser — one tab at a time.**

A Chrome extension + CLI that lets you selectively share browser tabs with AI agents (like Claude Code) for real-time inspection, interaction, and debugging. No `--remote-debugging-port` needed.

## ✨ Features

- 🔒 **Per-tab access control** — only explicitly shared tabs are accessible
- 📸 **Screenshots** — capture viewport with coordinate mapping
- 🌳 **Accessibility tree** — structured page snapshot for AI understanding
- ⌨️ **Interaction** — click elements, type text, navigate pages
- 🔍 **Console monitoring** — capture `console.log`, errors, warnings in real time
- 🌐 **Network monitoring** — watch requests/responses with POST bodies
- 👁️ **Visual indicator** — shared tabs show flashing 🟢🟡 in the tab title
- 📋 **Click-to-copy extension ID** — easy setup from the extension popup
- 🚀 **Zero npm dependencies** — uses Node.js 22+ built-in WebSocket

## 🏗️ How It Works

```
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
                                                ┌─────────────┐
                                                │   Chrome     │
                                                │  (shared tab)│
                                                └─────────────┘
```

1. 👤 **User** clicks the extension icon and shares a tab
2. 🔗 **Extension** attaches `chrome.debugger` to that tab
3. 🔌 **Native host** creates a Unix socket for the tab
4. 🤖 **AI agent** connects via the socket and sends CDP commands
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

Click the 🤖 extension icon → click **Share** next to the tab you want to expose.

The tab title will show a flashing 🟢🟡 indicator confirming it's shared.

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
- **Native messaging host** acts as a reverse proxy between CLI clients and the Chrome extension

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
