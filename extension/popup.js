const tabsDiv = document.getElementById('tabs');
const linksDiv = document.getElementById('links');
const linkForm = document.getElementById('linkForm');
const linkHostInput = document.getElementById('linkHost');
// Recent attaches/refusals shown per link (the proxy keeps a few more).
const LINK_ACTIVITY_SHOWN = 3;
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

// Active links first (from the proxy), then remembered hosts not linked now.
function renderLinks(links, remembered) {
  const active = new Set(links.map((l) => l.dest));
  const idle = remembered.filter((h) => !active.has(h));
  linksDiv.innerHTML = [
    ...links.map((l) => `
    <div class="link-row">
      <div class="link-main">
        <span class="link-dest">${escapeHtml(l.dest)}</span>
        <span class="link-state ${escapeHtml(l.state)}">${escapeHtml(l.state)}</span>
        <button class="unlink-btn" data-dest="${escapeHtml(l.dest)}">${l.state === 'error' ? 'Dismiss' : 'Unlink'}</button>
      </div>
      ${l.state === 'linked' ? '' : `<div class="link-detail">${escapeHtml(l.message || '')}</div>`}
      ${(l.activity || []).slice(-LINK_ACTIVITY_SHOWN).map((a) => `<div class="link-activity">${escapeHtml(a)}</div>`).join('')}
    </div>`),
    ...idle.map((h) => `
    <div class="link-row">
      <div class="link-main">
        <span class="link-dest">${escapeHtml(h)}</span>
        <span class="link-state">not linked</span>
        <button class="link-btn" data-dest="${escapeHtml(h)}">Link</button>
        <button class="forget-btn" data-dest="${escapeHtml(h)}" title="Forget this host">×</button>
      </div>
    </div>`),
  ].join('') || '<div class="link-detail">No remote hosts linked for this Chrome profile.</div>';
}

async function sendLinkAction(type, dest) {
  const resp = await chrome.runtime.sendMessage({ type, dest });
  if (!resp?.ok) alert('Error: ' + (resp?.error || 'unknown'));
  loadTabs();
}

linksDiv.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-dest]');
  if (!btn) return;
  const type = btn.classList.contains('unlink-btn') ? 'link_stop'
    : btn.classList.contains('forget-btn') ? 'forget_host' : 'link_start';
  sendLinkAction(type, btn.dataset.dest);
});

linkForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const dest = linkHostInput.value.trim();
  if (!dest) return;
  linkHostInput.value = '';
  sendLinkAction('link_start', dest);
});

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
  renderLinks(resp.links || [], resp.rememberedHosts || []);
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
