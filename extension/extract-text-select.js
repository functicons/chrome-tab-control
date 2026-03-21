// Tab Control — Copy text from selected area (injected into tab)
// User drags to select a rectangular area, then all visible text within
// that area is copied to the clipboard.

(function () {
  'use strict';

  const ROOT_ID = '__tc-copy-text-select';
  const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

  // Remove if already exists
  const existing = document.getElementById(ROOT_ID);
  if (existing) { existing.remove(); return; }

  // --- Build overlay ---
  const overlay = document.createElement('div');
  overlay.id = ROOT_ID;
  Object.assign(overlay.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    background: 'rgba(0,0,0,0.15)',
    userSelect: 'none',
    fontFamily: FONT,
  });

  // Hint
  const hint = document.createElement('div');
  Object.assign(hint.style, {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'rgba(0,0,0,0.7)',
    color: '#fff',
    padding: '12px 24px',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: FONT,
    fontWeight: '500',
    pointerEvents: 'none',
    transition: 'opacity 0.2s',
  });
  hint.textContent = 'Drag to select area · Esc to cancel';
  overlay.appendChild(hint);

  // Selection box
  const selBox = document.createElement('div');
  Object.assign(selBox.style, {
    position: 'fixed',
    border: '2px dashed #43a047',
    background: 'rgba(67, 160, 71, 0.08)',
    display: 'none',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  });
  overlay.appendChild(selBox);

  // Toast notification
  function showToast(msg, isError) {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed',
      top: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: isError ? 'rgba(229,57,53,0.9)' : 'rgba(67,160,71,0.9)',
      color: '#fff',
      padding: '10px 24px',
      borderRadius: '8px',
      fontSize: '14px',
      fontFamily: FONT,
      fontWeight: '500',
      zIndex: '2147483647',
      transition: 'opacity 0.3s',
      pointerEvents: 'none',
    });
    toast.textContent = msg;
    document.documentElement.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, 1500);
    setTimeout(() => toast.remove(), 1800);
  }

  document.documentElement.appendChild(overlay);

  let startX = 0, startY = 0;
  let dragging = false;

  function cleanup() { overlay.remove(); }

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    hint.style.opacity = '0';
    selBox.style.display = 'block';
    overlay.setPointerCapture(e.pointerId);
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selBox.style.left = x + 'px';
    selBox.style.top = y + 'px';
    selBox.style.width = w + 'px';
    selBox.style.height = h + 'px';
  });

  overlay.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    overlay.releasePointerCapture(e.pointerId);

    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    cleanup();

    if (w < 5 || h < 5) return;

    // Collect text from elements within the selected rectangle
    const selRect = { left: x, top: y, right: x + w, bottom: y + h };
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          // Skip hidden elements and our own overlay
          const el = node.parentElement;
          if (!el || el.closest('#__tc-annotate-root') || el.closest('#__tc-copy-text-select')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const texts = [];
    const seen = new Set();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent.trim();
      if (!text) continue;

      // Check if the text node's range intersects the selection
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      let intersects = false;
      for (const r of rects) {
        if (r.right > selRect.left && r.left < selRect.right &&
            r.bottom > selRect.top && r.top < selRect.bottom) {
          intersects = true;
          break;
        }
      }
      if (!intersects) continue;

      // Deduplicate
      if (seen.has(text)) continue;
      seen.add(text);
      texts.push(text);
    }

    const result = texts.join(' ');
    if (!result) {
      showToast('No text found in selected area', true);
      return;
    }

    navigator.clipboard.writeText(result).then(() => {
      showToast('Copied: ' + (result.length > 60 ? result.slice(0, 60) + '...' : result));
    }).catch(() => {
      showToast('Failed to copy to clipboard', true);
    });
  });

  // Escape to cancel
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      cleanup();
      document.removeEventListener('keydown', onKey);
    }
  });
})();
