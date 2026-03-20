// Tab Control — background service worker (Manifest V3)
// Manages debugger attachments and bridges CDP commands via native messaging.

const NATIVE_HOST = 'com.functicons.chrome_tab_control';

let nativePort = null;
const sharedTabs = new Map(); // tabId -> {url, title}
const annotatingTabs = new Set(); // tabId

// ---------------------------------------------------------------------------
// Tab context menu (right-click on tab)
// ---------------------------------------------------------------------------

const MENU_SHARE_ID = 'tab-control-toggle';
const MENU_ANNOTATE_ID = 'tab-control-annotate';
const MENU_SCREENSHOT_ID = 'tab-control-screenshot';

function updateContextMenu(tabId) {
  const isShared = sharedTabs.has(tabId);
  const isAnnotating = annotatingTabs.has(tabId);
  chrome.contextMenus.update(MENU_SHARE_ID, {
    title: isShared ? 'Unshare Tab' : 'Share Tab',
  }).catch(() => {});
  chrome.contextMenus.update(MENU_ANNOTATE_ID, {
    title: isAnnotating ? 'Stop Annotation' : 'Annotate',
  }).catch(() => {});
}

chrome.contextMenus.create({
  id: MENU_SHARE_ID,
  title: 'Share Tab',
  contexts: ['page'],
}, () => chrome.runtime.lastError);

chrome.contextMenus.create({
  id: MENU_ANNOTATE_ID,
  title: 'Annotate',
  contexts: ['page'],
}, () => chrome.runtime.lastError);

chrome.contextMenus.create({
  id: MENU_SCREENSHOT_ID,
  title: 'Screenshot',
  contexts: ['page'],
}, () => chrome.runtime.lastError);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_SHARE_ID) {
    if (sharedTabs.has(tab.id)) {
      unshareTab(tab.id);
    } else {
      shareTab(tab.id);
    }
  } else if (info.menuItemId === MENU_ANNOTATE_ID) {
    if (annotatingTabs.has(tab.id)) {
      removeAnnotation(tab.id);
    } else {
      injectAnnotation(tab.id);
    }
  } else if (info.menuItemId === MENU_SCREENSHOT_ID) {
    screenshotTab(tab);
  }
});

// Update menu text when user switches tabs
chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateContextMenu(tabId);
});

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
  annotatingTabs.delete(tabId);
  if (nativePort) {
    nativePort.postMessage({ type: 'tab_unshared', tabId, reason });
  }
  broadcastState();
});

// Handle tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!sharedTabs.has(tabId)) return;
  sharedTabs.delete(tabId);
  annotatingTabs.delete(tabId);
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

const TITLE_ICONS = ['⚪', '🟡'];
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
  annotatingTabs.delete(tabId);
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
// Screenshot
// ---------------------------------------------------------------------------

async function screenshotTab(tab) {
  // Inject area selector — actual capture happens when user selects area
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['screenshot-select.js'],
    });
  } catch (e) {
    console.warn('Screenshot selector injection failed:', e.message);
  }
}

async function captureAndCrop(windowId, rect, tab) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });

    // Crop using OffscreenCanvas in the service worker
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob, rect.x, rect.y, rect.w, rect.h);
    const canvas = new OffscreenCanvas(rect.w, rect.h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });

    // Convert blob to base64 data URL (blob/object URLs don't work for downloads in service workers)
    const buf = await croppedBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const croppedDataUrl = 'data:image/png;base64,' + btoa(binary);

    const now = new Date();
    const timestamp = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');
    const filename = `screenshot_${timestamp}.png`;
    await chrome.downloads.download({
      url: croppedDataUrl,
      filename,
      saveAs: true,
    });
  } catch (e) {
    console.warn('Screenshot capture/crop failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Annotation overlay
// ---------------------------------------------------------------------------

async function injectAnnotation(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['annotate.js'],
    });
    annotatingTabs.add(tabId);
    broadcastState();
  } catch (e) {
    console.warn('Failed to inject annotation:', e.message);
  }
}

async function removeAnnotation(tabId) {
  annotatingTabs.delete(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'annotate_toggle_off' });
  } catch {}
  broadcastState();
}

// Keyboard shortcut: toggle annotation on active tab
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'toggle-annotate') {
    if (annotatingTabs.has(tab.id)) {
      await removeAnnotation(tab.id);
    } else {
      await injectAnnotation(tab.id);
    }
  } else if (command === 'screenshot') {
    await screenshotTab(tab);
  }
});

// ---------------------------------------------------------------------------
// Popup communication
// ---------------------------------------------------------------------------

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'state_updated' }).catch(() => {});
  // Update context menu to reflect current tab's share state
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab) updateContextMenu(tab.id);
  }).catch(() => {});
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
          annotating: annotatingTabs.has(t.id),
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

  if (msg.type === 'annotate') {
    injectAnnotation(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'annotate_done') {
    const tabId = msg.tabId || _sender?.tab?.id;
    if (tabId) annotatingTabs.delete(tabId);
    broadcastState();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'screenshot') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) return screenshotTab(tab);
    })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'screenshot_area') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) return captureAndCrop(tab.windowId, msg.rect, tab);
    })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
