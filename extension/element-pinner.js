// Tab Control — Element pinner (injected into tab)
// Hover to highlight elements, click to pin them. Pinned elements
// can be queried by the AI agent via the CLI.

(function () {
  'use strict';

  const ROOT_ID = '__tc-element-selector';
  const PIN_ATTR = 'data-tc-pinned';
  const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  const HIGHLIGHT_COLOR = 'rgba(26, 115, 232, 0.15)';
  const HIGHLIGHT_BORDER = 'rgba(26, 115, 232, 0.8)';
  const PIN_COLOR = 'rgba(229, 57, 53, 0.12)';
  const PIN_BORDER = 'rgba(229, 57, 53, 0.8)';

  // Toggle off if already active
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    deactivate();
    return;
  }

  // --- State ---
  const pinnedElements = []; // {el, overlay, badge}
  let hoverOverlay = null;
  let hoverLabel = null;
  let active = true;

  // --- Root container ---
  const root = document.createElement('div');
  root.id = ROOT_ID;
  Object.assign(root.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    pointerEvents: 'none',
    fontFamily: FONT,
  });

  // --- Hover highlight overlay ---
  hoverOverlay = document.createElement('div');
  Object.assign(hoverOverlay.style, {
    position: 'fixed',
    background: HIGHLIGHT_COLOR,
    border: '2px solid ' + HIGHLIGHT_BORDER,
    borderRadius: '2px',
    pointerEvents: 'none',
    display: 'none',
    zIndex: '2147483646',
    transition: 'top 0.05s, left 0.05s, width 0.05s, height 0.05s',
    boxSizing: 'border-box',
  });
  root.appendChild(hoverOverlay);

  // --- Hover label (shows selector) ---
  hoverLabel = document.createElement('div');
  Object.assign(hoverLabel.style, {
    position: 'fixed',
    background: 'rgba(0,0,0,0.8)',
    color: '#fff',
    padding: '3px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontFamily: 'monospace',
    pointerEvents: 'none',
    display: 'none',
    zIndex: '2147483647',
    whiteSpace: 'nowrap',
    maxWidth: '400px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });
  root.appendChild(hoverLabel);

  // --- Toolbar ---
  const toolbar = document.createElement('div');
  Object.assign(toolbar.style, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '6px',
    background: '#fff',
    borderRadius: '10px',
    boxShadow: '0 2px 16px rgba(0,0,0,0.18)',
    padding: '6px 12px',
    pointerEvents: 'auto',
    zIndex: '2147483647',
    alignItems: 'center',
    userSelect: 'none',
    fontSize: '13px',
    fontFamily: FONT,
  });

  const statusText = document.createElement('span');
  statusText.textContent = 'Pin elements · Click to pin';
  Object.assign(statusText.style, { color: '#555', fontWeight: '500' });
  toolbar.appendChild(statusText);

  const sep = document.createElement('div');
  Object.assign(sep.style, { width: '1px', height: '18px', background: '#ddd', margin: '0 4px' });
  toolbar.appendChild(sep);

  function makeBtn(label) {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      all: 'unset',
      padding: '4px 12px',
      borderRadius: '6px',
      fontSize: '12px',
      fontWeight: '600',
      fontFamily: FONT,
      cursor: 'pointer',
      background: '#fff',
      color: '#333',
      border: '1px solid #ddd',
      transition: 'background 0.12s',
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = '#f0f0f0'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#fff'; });
    return btn;
  }

  const clearBtn = makeBtn('Clear All');
  const doneBtn = makeBtn('Done');
  Object.assign(doneBtn.style, { background: '#1a73e8', color: '#fff', borderColor: '#1a73e8' });
  doneBtn.addEventListener('mouseenter', () => { doneBtn.style.background = '#1557b0'; });
  doneBtn.addEventListener('mouseleave', () => { doneBtn.style.background = '#1a73e8'; });

  toolbar.appendChild(clearBtn);
  toolbar.appendChild(doneBtn);
  root.appendChild(toolbar);

  document.documentElement.appendChild(root);

  // --- Helpers ---
  function getSelector(el) {
    const tag = el.tagName.toLowerCase();
    let sel = tag;
    if (el.id) sel += '#' + el.id;
    const href = el.getAttribute('href');
    if (href) sel += '[href="' + href.slice(0, 60) + '"]';
    const role = el.getAttribute('role');
    if (role) sel += '[role="' + role + '"]';
    const type = el.getAttribute('type');
    if (tag === 'input' && type) sel += '[type="' + type + '"]';
    const name = el.getAttribute('name');
    if (name) sel += '[name="' + name + '"]';
    return sel;
  }

  function getSelectorWithText(el) {
    let sel = getSelector(el);
    const text = (el.getAttribute('aria-label') || el.innerText || '').trim();
    if (text) sel += ' "' + text.slice(0, 60) + '"';
    return sel;
  }

  function updateStatus() {
    const count = pinnedElements.length;
    statusText.textContent = count > 0
      ? count + ' pinned · Click to pin/unpin'
      : 'Pin elements · Click to pin';
  }

  // --- Pin overlay + badge for a pinned element ---
  function createPinOverlay(el, index) {
    const rect = el.getBoundingClientRect();
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      background: PIN_COLOR,
      border: '2px solid ' + PIN_BORDER,
      borderRadius: '2px',
      pointerEvents: 'none',
      zIndex: '2147483645',
      boxSizing: 'border-box',
    });

    const badge = document.createElement('div');
    Object.assign(badge.style, {
      position: 'absolute',
      top: '-10px',
      left: '-10px',
      width: '20px',
      height: '20px',
      borderRadius: '50%',
      background: PIN_BORDER,
      color: '#fff',
      fontSize: '11px',
      fontWeight: '700',
      fontFamily: FONT,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    badge.textContent = String(index + 1);
    overlay.appendChild(badge);
    root.appendChild(overlay);
    return { overlay, badge };
  }

  function refreshPinOverlays() {
    pinnedElements.forEach((p, i) => {
      const rect = p.el.getBoundingClientRect();
      Object.assign(p.overlay.style, {
        left: rect.left + 'px',
        top: rect.top + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });
      p.badge.textContent = String(i + 1);
    });
  }

  // --- Event handlers ---
  function onMouseMove(e) {
    if (!active) return;
    const el = e.target;
    if (!el || el.closest('#' + ROOT_ID)) {
      hoverOverlay.style.display = 'none';
      hoverLabel.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    Object.assign(hoverOverlay.style, {
      display: 'block',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });
    hoverLabel.textContent = getSelector(el);
    Object.assign(hoverLabel.style, {
      display: 'block',
      left: rect.left + 'px',
      top: Math.max(0, rect.top - 24) + 'px',
    });
  }

  function onClick(e) {
    if (!active) return;
    const el = e.target;
    if (!el || el.closest('#' + ROOT_ID)) return;
    e.preventDefault();
    e.stopPropagation();

    // Check if already pinned → unpin
    const idx = pinnedElements.findIndex((p) => p.el === el);
    if (idx !== -1) {
      const removed = pinnedElements.splice(idx, 1)[0];
      removed.overlay.remove();
      removed.el.removeAttribute(PIN_ATTR);
      // Re-number remaining
      pinnedElements.forEach((p, i) => {
        p.el.setAttribute(PIN_ATTR, String(i + 1));
      });
      refreshPinOverlays();
      updateStatus();
      return;
    }

    // Pin the element
    const pinIndex = pinnedElements.length;
    el.setAttribute(PIN_ATTR, String(pinIndex + 1));
    const { overlay: pinOverlay, badge } = createPinOverlay(el, pinIndex);
    pinnedElements.push({ el, overlay: pinOverlay, badge });
    updateStatus();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      deactivate();
    }
  }

  // Use capture phase so we get events before the page
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  // Refresh pin positions on scroll/resize (stays active after deactivation)
  const refreshHandler = () => { if (pinnedElements.length) refreshPinOverlays(); };
  window.addEventListener('scroll', refreshHandler, true);
  window.addEventListener('resize', refreshHandler);

  // --- Button handlers ---
  clearBtn.addEventListener('click', () => {
    pinnedElements.forEach((p) => {
      p.overlay.remove();
      p.el.removeAttribute(PIN_ATTR);
    });
    pinnedElements.length = 0;
    updateStatus();
  });

  doneBtn.addEventListener('click', () => {
    deactivate();
  });

  function deactivate() {
    active = false;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    // Keep scroll/resize handlers alive so pin overlays follow elements
    // Move pin overlays to body so they persist
    pinnedElements.forEach((p) => {
      document.documentElement.appendChild(p.overlay);
    });
    root.remove();
    chrome.runtime.sendMessage({ type: 'selector_done' }).catch(() => {});
  }

  // --- Listen for toggle-off from background ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'selector_toggle_off') {
      deactivate();
    }
  });
})();
