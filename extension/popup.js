const tabsDiv = document.getElementById('tabs');
const statusEl = document.getElementById('status');

function escapeHtml(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function render(tabs) {
  const shared = tabs.filter((t) => t.shared).length;
  statusEl.textContent = shared > 0 ? `${shared} shared` : '';

  if (!tabs.length) {
    tabsDiv.innerHTML = '<div class="empty">No tabs found</div>';
    return;
  }

  tabsDiv.innerHTML = tabs
    .map(
      (t) => `
    <div class="tab-item ${t.shared ? 'shared' : ''}">
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(t.title || 'Untitled')}</div>
        <div class="tab-meta">
          <span class="tab-id">#${t.tabId}</span>
          <span class="tab-url">${escapeHtml(t.url)}</span>
        </div>
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

tabsDiv.addEventListener('click', async (e) => {
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

  loadTabs();
});

async function loadTabs() {
  const resp = await chrome.runtime.sendMessage({ type: 'get_state' });
  if (resp?.tabs) render(resp.tabs);
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

loadTabs();
