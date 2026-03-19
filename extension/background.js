// Tab Control — background service worker (Manifest V3)
// Manages debugger attachments and bridges CDP commands via native messaging.

const NATIVE_HOST = 'com.anthropic.cdp_tab_control';

let nativePort = null;
const sharedTabs = new Map(); // tabId -> {url, title}

// ---------------------------------------------------------------------------
// Native messaging
// ---------------------------------------------------------------------------

function ensureNativePort() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);

  nativePort.onMessage.addListener((msg) => {
    if (msg.type === 'cdp_command') {
      handleCdpCommand(msg);
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) console.warn('Native host disconnected:', err.message);
    nativePort = null;
  });

  // Send current shared tabs state so native host can recreate sockets
  if (sharedTabs.size > 0) {
    for (const [tabId, info] of sharedTabs) {
      nativePort.postMessage({ type: 'tab_shared', tabId, url: info.url, title: info.title });
    }
  }

  return nativePort;
}

async function handleCdpCommand(msg) {
  const { requestId, tabId, method, params } = msg;
  if (!nativePort) return;

  if (!sharedTabs.has(tabId)) {
    nativePort.postMessage({ type: 'cdp_error', requestId, error: `Tab ${tabId} is not shared` });
    return;
  }

  try {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
    nativePort.postMessage({ type: 'cdp_response', requestId, result: result || {} });
  } catch (e) {
    nativePort.postMessage({ type: 'cdp_error', requestId, error: e.message });
  }
}

// Forward all CDP events to native host
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!nativePort) return;
  if (!sharedTabs.has(source.tabId)) return;
  nativePort.postMessage({ type: 'cdp_event', tabId: source.tabId, method, params });
});

// Handle debugger detach (user clicked "cancel" on the bar, or Chrome detached it)
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!sharedTabs.has(tabId)) return;
  removeTitlePrefix(tabId);
  sharedTabs.delete(tabId);
  if (nativePort) {
    nativePort.postMessage({ type: 'tab_unshared', tabId, reason });
  }
  broadcastState();
});

// Handle tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!sharedTabs.has(tabId)) return;
  sharedTabs.delete(tabId);
  if (nativePort) {
    nativePort.postMessage({ type: 'tab_unshared', tabId, reason: 'tab_closed' });
  }
  broadcastState();
});

// Handle tab URL/title changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!sharedTabs.has(tabId)) return;
  const info = sharedTabs.get(tabId);
  if (changeInfo.url) info.url = changeInfo.url;
  if (changeInfo.title) info.title = changeInfo.title;
  if (changeInfo.url || changeInfo.title) {
    if (nativePort) {
      nativePort.postMessage({ type: 'tab_updated', tabId, url: info.url, title: info.title });
    }
    broadcastState();
  }
});

// ---------------------------------------------------------------------------
// Shared tab indicator (prefix on tab title)
// ---------------------------------------------------------------------------

const TITLE_ICONS = ['🟢', '🟡'];
const TITLE_FLASH_MS = 800;

async function addTitlePrefix(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (icons, intervalMs) => {
        if (window.__cdpTitleFlasher) clearInterval(window.__cdpTitleFlasher);

        // Strip any existing icon prefix
        let baseTitle = document.title;
        for (const icon of icons) {
          if (baseTitle.startsWith(icon + ' ')) { baseTitle = baseTitle.slice(icon.length + 1); break; }
        }
        window.__cdpBaseTitle = baseTitle;
        window.__cdpUpdating = false;

        let idx = 0;
        function flash() {
          window.__cdpUpdating = true;
          document.title = icons[idx % icons.length] + ' ' + window.__cdpBaseTitle;
          window.__cdpUpdating = false;
          idx++;
        }
        flash();
        window.__cdpTitleFlasher = setInterval(flash, intervalMs);

        // Track external title changes
        if (window.__cdpTitleObserver) window.__cdpTitleObserver.disconnect();
        window.__cdpTitleObserver = new MutationObserver(() => {
          if (window.__cdpUpdating) return;
          let t = document.title;
          for (const icon of icons) {
            if (t.startsWith(icon + ' ')) { t = t.slice(icon.length + 1); break; }
          }
          window.__cdpBaseTitle = t;
        });
        const titleEl = document.querySelector('title');
        if (titleEl) {
          window.__cdpTitleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
        }
      },
      args: [TITLE_ICONS, TITLE_FLASH_MS],
    });
  } catch {}
}

async function removeTitlePrefix(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (icons) => {
        if (window.__cdpTitleFlasher) {
          clearInterval(window.__cdpTitleFlasher);
          delete window.__cdpTitleFlasher;
        }
        if (window.__cdpTitleObserver) {
          window.__cdpTitleObserver.disconnect();
          delete window.__cdpTitleObserver;
        }
        let t = document.title;
        for (const icon of icons) {
          if (t.startsWith(icon + ' ')) { t = t.slice(icon.length + 1); break; }
        }
        document.title = t;
      },
      args: [TITLE_ICONS],
    });
  } catch {}
}

// Re-add prefix after page navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!sharedTabs.has(tabId)) return;
  if (changeInfo.status === 'complete') {
    addTitlePrefix(tabId);
  }
});

// ---------------------------------------------------------------------------
// Share / unshare
// ---------------------------------------------------------------------------

async function shareTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.debugger.attach({ tabId }, '1.3');

  sharedTabs.set(tabId, { url: tab.url, title: tab.title });

  const port = ensureNativePort();
  port.postMessage({ type: 'tab_shared', tabId, url: tab.url, title: tab.title });
  await addTitlePrefix(tabId);
  broadcastState();
}

async function unshareTab(tabId) {
  await removeTitlePrefix(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached
  }
  sharedTabs.delete(tabId);
  if (nativePort) {
    nativePort.postMessage({ type: 'tab_unshared', tabId, reason: 'user' });
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// Popup communication
// ---------------------------------------------------------------------------

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'state_updated' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get_state') {
    chrome.tabs.query({}).then((tabs) => {
      const tabList = tabs
        .filter((t) => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
        .map((t) => ({
          tabId: t.id,
          url: t.url,
          title: t.title,
          shared: sharedTabs.has(t.id),
        }));
      sendResponse({ tabs: tabList });
    });
    return true; // async
  }

  if (msg.type === 'share') {
    shareTab(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'unshare') {
    unshareTab(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
