// Tab Control — Screenshot area selector (injected into tab)
// Phase 1: Drag to select area. Phase 2: Resize handles + Capture button.

(function () {
  'use strict';

  const ROOT_ID = '__tc-screenshot-select';
  const HANDLE_SIZE = 10;
  const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

  // Remove if already exists
  const existing = document.getElementById(ROOT_ID);
  if (existing) { existing.remove(); return; }

  // --- State ---
  // Selection rect in CSS pixels
  let selX = 0, selY = 0, selW = 0, selH = 0;
  let phase = 'draw'; // 'draw' | 'adjust'
  let dragType = null; // 'draw' | 'move' | handle id
  let dragStartX = 0, dragStartY = 0;
  let dragOrigRect = null;

  // --- Build DOM ---
  const overlay = document.createElement('div');
  overlay.id = ROOT_ID;
  Object.assign(overlay.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    userSelect: 'none',
    fontFamily: FONT,
  });

  // Dark mask with cutout (4 rects around selection)
  const MASK_BG = 'rgba(0,0,0,0.35)';
  const masks = {};
  ['top', 'bottom', 'left', 'right'].forEach((side) => {
    const m = document.createElement('div');
    Object.assign(m.style, {
      position: 'fixed',
      background: MASK_BG,
      pointerEvents: 'none',
    });
    overlay.appendChild(m);
    masks[side] = m;
  });

  function updateMask() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Top
    Object.assign(masks.top.style, { top: '0', left: '0', width: vw + 'px', height: selY + 'px' });
    // Bottom
    Object.assign(masks.bottom.style, { top: (selY + selH) + 'px', left: '0', width: vw + 'px', height: (vh - selY - selH) + 'px' });
    // Left
    Object.assign(masks.left.style, { top: selY + 'px', left: '0', width: selX + 'px', height: selH + 'px' });
    // Right
    Object.assign(masks.right.style, { top: selY + 'px', left: (selX + selW) + 'px', width: (vw - selX - selW) + 'px', height: selH + 'px' });
  }

  // Selection border
  const selBorder = document.createElement('div');
  Object.assign(selBorder.style, {
    position: 'fixed',
    border: '2px solid #1a73e8',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    display: 'none',
  });
  overlay.appendChild(selBorder);

  // Dimension label
  const dimLabel = document.createElement('div');
  Object.assign(dimLabel.style, {
    position: 'fixed',
    background: 'rgba(0,0,0,0.75)',
    color: '#fff',
    padding: '3px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontFamily: 'monospace',
    pointerEvents: 'none',
    display: 'none',
    whiteSpace: 'nowrap',
  });
  overlay.appendChild(dimLabel);

  // Resize handles (8: 4 corners + 4 edges)
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const HANDLE_CURSORS = {
    nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
    se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
  };
  const handleEls = {};
  HANDLES.forEach((id) => {
    const h = document.createElement('div');
    Object.assign(h.style, {
      position: 'fixed',
      width: HANDLE_SIZE + 'px',
      height: HANDLE_SIZE + 'px',
      background: '#fff',
      border: '1.5px solid #1a73e8',
      borderRadius: '2px',
      cursor: HANDLE_CURSORS[id],
      display: 'none',
      boxSizing: 'border-box',
      zIndex: '1',
    });
    h.dataset.handle = id;
    overlay.appendChild(h);
    handleEls[id] = h;
  });

  // Toolbar (Capture + Cancel buttons)
  const toolbar = document.createElement('div');
  Object.assign(toolbar.style, {
    position: 'fixed',
    display: 'none',
    gap: '6px',
    background: '#fff',
    borderRadius: '8px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
    padding: '6px 8px',
    zIndex: '1',
    pointerEvents: 'auto',
    fontFamily: FONT,
  });

  function makeBtn(label, primary) {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      all: 'unset',
      padding: '5px 14px',
      borderRadius: '6px',
      fontSize: '12px',
      fontWeight: '600',
      fontFamily: FONT,
      cursor: 'pointer',
      background: primary ? '#1a73e8' : '#fff',
      color: primary ? '#fff' : '#333',
      border: primary ? '1px solid #1a73e8' : '1px solid #ddd',
      transition: 'background 0.12s',
    });
    return btn;
  }

  const captureBtn = makeBtn('Capture', true);
  const cancelBtn = makeBtn('Cancel', false);
  toolbar.appendChild(captureBtn);
  toolbar.appendChild(cancelBtn);
  overlay.appendChild(toolbar);

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

  document.documentElement.appendChild(overlay);

  // --- Position helpers ---
  function updateUI() {
    selBorder.style.left = selX + 'px';
    selBorder.style.top = selY + 'px';
    selBorder.style.width = selW + 'px';
    selBorder.style.height = selH + 'px';
    updateMask();

    const dpr = window.devicePixelRatio || 1;
    dimLabel.textContent = `${Math.round(selW * dpr)} × ${Math.round(selH * dpr)}`;
    // Position dim label below selection, centered
    dimLabel.style.left = (selX + selW / 2) + 'px';
    dimLabel.style.top = (selY + selH + 8) + 'px';
    dimLabel.style.transform = 'translateX(-50%)';

    if (phase === 'adjust') {
      positionHandles();
      positionToolbar();
    }
  }

  function positionHandles() {
    const cx = selX + selW / 2, cy = selY + selH / 2;
    const hs = HANDLE_SIZE / 2;
    const pos = {
      nw: [selX, selY], n: [cx, selY], ne: [selX + selW, selY],
      w: [selX, cy], e: [selX + selW, cy],
      sw: [selX, selY + selH], s: [cx, selY + selH], se: [selX + selW, selY + selH],
    };
    HANDLES.forEach((id) => {
      handleEls[id].style.left = (pos[id][0] - hs) + 'px';
      handleEls[id].style.top = (pos[id][1] - hs) + 'px';
    });
  }

  function positionToolbar() {
    // Position toolbar below selection, centered
    toolbar.style.left = (selX + selW / 2) + 'px';
    toolbar.style.top = (selY + selH + 32) + 'px';
    toolbar.style.transform = 'translateX(-50%)';
    // If toolbar goes off bottom, put it above
    const tbRect = toolbar.getBoundingClientRect();
    if (tbRect.bottom > window.innerHeight - 8) {
      toolbar.style.top = (selY - 44) + 'px';
    }
  }

  function enterAdjustPhase() {
    phase = 'adjust';
    overlay.style.cursor = 'default';
    selBorder.style.cursor = 'move';
    selBorder.style.pointerEvents = 'auto';
    selBorder.style.display = 'block';
    dimLabel.style.display = 'block';
    toolbar.style.display = 'flex';
    HANDLES.forEach((id) => { handleEls[id].style.display = 'block'; });
    updateUI();
  }

  function cleanup() {
    overlay.remove();
  }

  // --- Phase 1: Draw selection ---
  overlay.addEventListener('pointerdown', (e) => {
    if (phase !== 'draw' && e.target === overlay) {
      // Click outside selection in adjust phase → restart
      phase = 'draw';
      toolbar.style.display = 'none';
      HANDLES.forEach((id) => { handleEls[id].style.display = 'none'; });
      selBorder.style.pointerEvents = 'none';
      overlay.style.cursor = 'crosshair';
      hint.style.opacity = '1';
      hint.style.display = '';
      selBorder.style.display = 'none';
      dimLabel.style.display = 'none';
      // Reset mask
      Object.values(masks).forEach((m) => { m.style.width = '0'; m.style.height = '0'; });
    }
    if (phase !== 'draw') return;

    e.preventDefault();
    dragType = 'draw';
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    hint.style.opacity = '0';
    selBorder.style.display = 'block';
    dimLabel.style.display = 'block';
    overlay.setPointerCapture(e.pointerId);
  });

  // --- Phase 2: Move / resize ---
  selBorder.addEventListener('pointerdown', (e) => {
    if (phase !== 'adjust') return;
    e.preventDefault();
    e.stopPropagation();
    dragType = 'move';
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOrigRect = { x: selX, y: selY, w: selW, h: selH };
    selBorder.setPointerCapture(e.pointerId);
  });

  HANDLES.forEach((id) => {
    handleEls[id].addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragType = id;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragOrigRect = { x: selX, y: selY, w: selW, h: selH };
      handleEls[id].setPointerCapture(e.pointerId);
    });
  });

  // --- Unified pointermove / pointerup on overlay (captures bubble up) ---
  overlay.addEventListener('pointermove', (e) => {
    if (!dragType) return;
    e.preventDefault();
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    if (dragType === 'draw') {
      selX = Math.min(dragStartX, e.clientX);
      selY = Math.min(dragStartY, e.clientY);
      selW = Math.abs(e.clientX - dragStartX);
      selH = Math.abs(e.clientY - dragStartY);
      updateUI();
    } else if (dragType === 'move') {
      selX = dragOrigRect.x + dx;
      selY = dragOrigRect.y + dy;
      updateUI();
    } else {
      // Resize handle
      resizeFromHandle(dragType, dx, dy);
      updateUI();
    }
  });

  overlay.addEventListener('pointerup', (e) => {
    if (!dragType) return;
    const wasDraw = dragType === 'draw';
    dragType = null;

    if (wasDraw) {
      overlay.releasePointerCapture(e.pointerId);
      if (selW < 5 || selH < 5) {
        // Too small, reset
        selBorder.style.display = 'none';
        dimLabel.style.display = 'none';
        hint.style.opacity = '1';
        return;
      }
      enterAdjustPhase();
    } else {
      updateUI();
    }
  });

  function resizeFromHandle(handle, dx, dy) {
    const o = dragOrigRect;
    let x = o.x, y = o.y, w = o.w, h = o.h;

    if (handle.includes('w')) { x = o.x + dx; w = o.w - dx; }
    if (handle.includes('e')) { w = o.w + dx; }
    if (handle.includes('n')) { y = o.y + dy; h = o.h - dy; }
    if (handle.includes('s')) { h = o.h + dy; }

    // Prevent negative size — flip
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }

    selX = x; selY = y; selW = w; selH = h;
  }

  // --- Capture / Cancel ---
  captureBtn.addEventListener('click', () => {
    const dpr = window.devicePixelRatio || 1;
    const rect = {
      x: Math.round(selX * dpr),
      y: Math.round(selY * dpr),
      w: Math.round(selW * dpr),
      h: Math.round(selH * dpr),
    };
    cleanup();
    chrome.runtime.sendMessage({ type: 'screenshot_area', rect, dpr });
  });

  cancelBtn.addEventListener('click', cleanup);

  // Escape to cancel
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      cleanup();
      document.removeEventListener('keydown', onKey);
    }
  });
})();
