const tabsDiv = document.getElementById('tabs');
const statusEl = document.getElementById('status');
const COPIED_FEEDBACK_MS = 2000;

// Tab whose Copy button shows "Copied!". Kept as state (not a DOM tweak) because
// sharing broadcasts a state update that re-renders the list.
let copiedTabId = null;
let copiedTimer = null;

function markCopied(tabId) {
  copiedTabId = tabId;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copiedTabId = null; loadTabs(); }, COPIED_FEEDBACK_MS);
  loadTabs();
}

function escapeHtml(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// The tab the user is looking at goes first: it is almost always the one
// being shared or whose tab handle is needed.
function activeFirst(tabs, activeTabId) {
  const active = tabs.filter((t) => t.tabId === activeTabId);
  return [...active, ...tabs.filter((t) => t.tabId !== activeTabId)];
}

function render(tabs, activeTabId) {
  const shared = tabs.filter((t) => t.shared).length;
  statusEl.textContent = shared > 0 ? `${shared} shared` : '';

  if (!tabs.length) {
    tabsDiv.innerHTML = '<div class="empty">No tabs found</div>';
    return;
  }

  tabsDiv.innerHTML = activeFirst(tabs, activeTabId)
    .map(
      (t) => `
    <div class="tab-item ${t.shared ? 'shared' : ''} ${t.tabId === activeTabId ? 'active' : ''}">
      <div class="tab-info">
        <div class="tab-title">${t.tabId === activeTabId ? '<span class="this-tab">This tab</span>' : ''}${escapeHtml(t.title || 'Untitled')}</div>
        <div class="tab-meta">
          <span class="tab-id">#${t.tabId}</span>
          <span class="tab-url">${escapeHtml(t.url)}</span>
        </div>
        ${t.handle ? `
        <div class="tab-handle" data-handle="${escapeHtml(t.handle)}" data-tab-id="${t.tabId}" title="Give this to your agent; it is the only way to reach the tab">
          \u{1F511} <code>${escapeHtml(t.handle)}</code>
          ${t.tabId === copiedTabId
            ? '<button class="copy-btn copied">Copied!</button>'
            : '<button class="copy-btn">Copy</button>'}
          <label class="remote-toggle ${t.remote ? 'on' : ''}" title="Let agents on other machines reach this tab (through tab-control remote)">
            <input type="checkbox" class="remote-cb" data-tab-id="${t.tabId}" ${t.remote ? 'checked' : ''}> Remote
          </label>
        </div>` : ''}
      </div>
      <button class="share-btn ${t.shared ? 'shared' : ''}"
              data-tab-id="${t.tabId}">
        ${t.shared ? 'Unshare' : 'Share'}
      </button>
    </div>
  `
    )
    .join('');
}

function copyTabHandle(el) {
  navigator.clipboard.writeText(el.dataset.handle)
    .then(() => markCopied(parseInt(el.dataset.tabId, 10)));
}

tabsDiv.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.copy-btn');
  if (copyBtn) {
    copyTabHandle(copyBtn.closest('.tab-handle'));
    return;
  }

  const btn = e.target.closest('.share-btn');
  if (!btn || btn.disabled) return;

  const tabId = parseInt(btn.dataset.tabId, 10);
  const isShared = btn.classList.contains('shared');

  btn.disabled = true;
  btn.textContent = '...';

  const resp = await chrome.runtime.sendMessage({
    type: isShared ? 'unshare' : 'share',
    tabId,
  });

  if (!resp.ok) {
    alert('Error: ' + resp.error);
  }

  // Sharing already copied the tab handle to the clipboard; show that.
  if (resp.ok && resp.copied) markCopied(tabId);
  else loadTabs();
});

tabsDiv.addEventListener('change', async (e) => {
  const cb = e.target.closest('.remote-cb');
  if (!cb) return;
  const resp = await chrome.runtime.sendMessage({
    type: 'set_remote', tabId: parseInt(cb.dataset.tabId, 10), remote: cb.checked,
  });
  if (!resp?.ok) alert('Error: ' + (resp?.error || 'unknown'));
  loadTabs();
});

async function loadTabs() {
  const [resp, [activeTab]] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'get_state' }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  if (!resp?.tabs) return;
  render(resp.tabs, activeTab?.id);
}

// Listen for state changes from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state_updated') loadTabs();
});

// Show extension ID with click-to-copy
const extIdEl = document.getElementById('extId');
extIdEl.textContent = chrome.runtime.id;
extIdEl.addEventListener('click', () => {
  navigator.clipboard.writeText(chrome.runtime.id).then(() => {
    extIdEl.classList.add('copied');
    extIdEl.textContent = 'Copied!';
    setTimeout(() => {
      extIdEl.classList.remove('copied');
      extIdEl.textContent = chrome.runtime.id;
    }, 1500);
  });
});

// Screenshot button
const screenshotBtn = document.getElementById('screenshotBtn');
screenshotBtn.addEventListener('click', async () => {
  screenshotBtn.disabled = true;
  screenshotBtn.textContent = '...';
  await chrome.runtime.sendMessage({ type: 'screenshot' });
  screenshotBtn.textContent = '✓';
  setTimeout(() => {
    screenshotBtn.disabled = false;
    screenshotBtn.textContent = '📷';
  }, 1000);
});

loadTabs();
