// Tab Control — Annotation overlay (injected into shared tabs)
// Provides circle, rectangle, arrow, and text drawing tools on an SVG overlay.
// Annotations are visible in CDP screenshots so the AI agent can see them.

(function () {
  'use strict';

  const ROOT_ID = '__tc-annotate-root';

  // If already active, remove it (toggle behavior)
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    existing.remove();
    chrome.runtime.sendMessage({ type: 'annotate_done' }).catch(() => {});
    return;
  }

  // --- Constants ---
  const COLORS = [
    { id: 'red',    hex: '#e53935', fill: 'rgba(229, 57, 53, 0.08)' },
    { id: 'blue',   hex: '#1e88e5', fill: 'rgba(30, 136, 229, 0.08)' },
    { id: 'green',  hex: '#43a047', fill: 'rgba(67, 160, 71, 0.08)' },
    { id: 'orange', hex: '#fb8c00', fill: 'rgba(251, 140, 0, 0.08)' },
    { id: 'purple', hex: '#8e24aa', fill: 'rgba(142, 36, 170, 0.08)' },
    { id: 'black',  hex: '#212121', fill: 'rgba(33, 33, 33, 0.08)' },
  ];
  const STROKE_WIDTH = 2.5;
  const FONT_SIZE = 20;

  // --- State ---
  let activeTool = null; // 'circle' | 'rect' | 'arrow' | 'text' | null
  let activeColorIdx = 0;
  let drawing = false;
  let startX = 0, startY = 0;
  let previewEl = null;

  function getColor() { return COLORS[activeColorIdx]; }

  // --- Build DOM ---
  const root = document.createElement('div');
  root.id = ROOT_ID;
  Object.assign(root.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    pointerEvents: 'none',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  });

  // Toolbar
  const toolbar = document.createElement('div');
  Object.assign(toolbar.style, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '4px',
    background: '#fff',
    borderRadius: '10px',
    boxShadow: '0 2px 16px rgba(0,0,0,0.18)',
    padding: '6px 10px',
    pointerEvents: 'auto',
    zIndex: '2147483647',
    alignItems: 'center',
    userSelect: 'none',
  });

  const DRAWING_TOOLS = ['circle', 'rect', 'arrow', 'text'];

  const tools = [
    { id: 'circle', label: 'Circle (C)',    icon: '○' },
    { id: 'rect',   label: 'Rectangle (R)', icon: '□' },
    { id: 'arrow',  label: 'Arrow (A)',     icon: '→' },
    { id: 'text',   label: 'Text (T)',      icon: 'T' },
    { id: 'undo',   label: 'Undo (Cmd+Z)',  icon: '↩' },
    { id: 'clear',  label: 'Clear',         icon: '✕' },
    { id: 'done',   label: 'Done (Esc)',    icon: '✓' },
  ];

  const btnStyle = {
    all: 'unset',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '16px',
    fontWeight: '600',
    color: '#555',
    transition: 'background 0.12s, color 0.12s',
    border: '1px solid transparent',
  };

  const buttons = {};

  function addSeparator() {
    const sep = document.createElement('div');
    Object.assign(sep.style, {
      width: '1px',
      height: '20px',
      background: '#ddd',
      margin: '0 4px',
    });
    toolbar.appendChild(sep);
    return sep;
  }

  tools.forEach((tool) => {
    const btn = document.createElement('button');
    btn.title = tool.label;
    btn.textContent = tool.icon;
    Object.assign(btn.style, btnStyle);
    btn.dataset.tool = tool.id;

    btn.addEventListener('mouseenter', () => {
      if (activeTool !== tool.id) btn.style.background = '#f0f0f0';
    });
    btn.addEventListener('mouseleave', () => {
      if (activeTool !== tool.id) btn.style.background = 'transparent';
    });

    if (tool.id === 'undo') addSeparator();

    toolbar.appendChild(btn);
    buttons[tool.id] = btn;
  });

  // --- Color picker (after Done, separated) ---
  addSeparator();

  const colorBtns = [];
  COLORS.forEach((color, idx) => {
    const btn = document.createElement('button');
    btn.title = color.id;
    Object.assign(btn.style, {
      all: 'unset',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '22px',
      height: '22px',
      borderRadius: '50%',
      cursor: 'pointer',
      background: color.hex,
      border: idx === 0 ? '2.5px solid #333' : '2.5px solid transparent',
      transition: 'border-color 0.12s, transform 0.12s',
      margin: '0 1px',
      boxSizing: 'border-box',
    });
    btn.addEventListener('mouseenter', () => {
      if (activeColorIdx !== idx) btn.style.transform = 'scale(1.15)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
    });
    btn.addEventListener('click', () => setActiveColor(idx));
    toolbar.appendChild(btn);
    colorBtns.push(btn);
  });

  // SVG overlay
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('xmlns', svgNS);
  Object.assign(svg.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  });

  // Arrowhead markers — one per color
  const defs = document.createElementNS(svgNS, 'defs');
  COLORS.forEach((color) => {
    const marker = document.createElementNS(svgNS, 'marker');
    marker.setAttribute('id', `__tc-arrowhead-${color.id}`);
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '3.5');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerUnits', 'strokeWidth');
    const arrowPath = document.createElementNS(svgNS, 'polygon');
    arrowPath.setAttribute('points', '0 0, 10 3.5, 0 7');
    arrowPath.setAttribute('fill', color.hex);
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);

  root.appendChild(toolbar);
  root.appendChild(svg);
  document.documentElement.appendChild(root);

  // --- Shape history (for undo) ---
  const shapes = [];

  // --- Helpers ---
  function setActiveTool(toolId) {
    activeTool = toolId;
    DRAWING_TOOLS.forEach((id) => {
      const btn = buttons[id];
      if (id === toolId) {
        btn.style.background = '#1a73e8';
        btn.style.color = '#fff';
        btn.style.borderColor = '#1a73e8';
      } else {
        btn.style.background = 'transparent';
        btn.style.color = '#555';
        btn.style.borderColor = 'transparent';
      }
    });
    svg.style.pointerEvents = toolId ? 'all' : 'none';
    svg.style.cursor = toolId === 'text' ? 'text' : toolId ? 'crosshair' : 'default';
  }

  function setActiveColor(idx) {
    activeColorIdx = idx;
    colorBtns.forEach((btn, i) => {
      btn.style.borderColor = i === idx ? '#333' : 'transparent';
    });
  }

  function createEllipse(cx, cy, rx, ry) {
    const c = getColor();
    const el = document.createElementNS(svgNS, 'ellipse');
    el.setAttribute('cx', cx);
    el.setAttribute('cy', cy);
    el.setAttribute('rx', rx);
    el.setAttribute('ry', ry);
    el.setAttribute('stroke', c.hex);
    el.setAttribute('stroke-width', STROKE_WIDTH);
    el.setAttribute('fill', c.fill);
    return el;
  }

  function createRect(x, y, w, h) {
    const c = getColor();
    const el = document.createElementNS(svgNS, 'rect');
    el.setAttribute('x', x);
    el.setAttribute('y', y);
    el.setAttribute('width', w);
    el.setAttribute('height', h);
    el.setAttribute('stroke', c.hex);
    el.setAttribute('stroke-width', STROKE_WIDTH);
    el.setAttribute('fill', c.fill);
    el.setAttribute('rx', '3');
    return el;
  }

  function createLine(x1, y1, x2, y2) {
    const c = getColor();
    const el = document.createElementNS(svgNS, 'line');
    el.setAttribute('x1', x1);
    el.setAttribute('y1', y1);
    el.setAttribute('x2', x2);
    el.setAttribute('y2', y2);
    el.setAttribute('stroke', c.hex);
    el.setAttribute('stroke-width', STROKE_WIDTH);
    el.setAttribute('marker-end', `url(#__tc-arrowhead-${c.id})`);
    return el;
  }

  function createText(x, y, content) {
    const c = getColor();
    const el = document.createElementNS(svgNS, 'text');
    el.setAttribute('x', x);
    el.setAttribute('y', y);
    el.setAttribute('fill', c.hex);
    el.setAttribute('font-size', FONT_SIZE);
    el.setAttribute('font-weight', 'bold');
    el.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif");
    el.setAttribute('stroke', '#fff');
    el.setAttribute('stroke-width', '3');
    el.setAttribute('paint-order', 'stroke');
    el.textContent = content;
    return el;
  }

  // --- Tool button handlers ---
  DRAWING_TOOLS.forEach((id) => {
    buttons[id].addEventListener('click', () => setActiveTool(activeTool === id ? null : id));
  });

  buttons.undo.addEventListener('click', () => {
    const last = shapes.pop();
    if (last) last.remove();
  });

  buttons.clear.addEventListener('click', () => {
    shapes.forEach((s) => s.remove());
    shapes.length = 0;
  });

  buttons.done.addEventListener('click', () => {
    root.remove();
    chrome.runtime.sendMessage({ type: 'annotate_done' }).catch(() => {});
  });

  // --- SVG drawing handlers ---
  svg.addEventListener('pointerdown', (e) => {
    if (!activeTool || activeTool === 'text') return;
    e.preventDefault();
    drawing = true;
    const rect = svg.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;

    if (activeTool === 'circle') {
      previewEl = createEllipse(startX, startY, 0, 0);
      svg.appendChild(previewEl);
    } else if (activeTool === 'rect') {
      previewEl = createRect(startX, startY, 0, 0);
      svg.appendChild(previewEl);
    } else if (activeTool === 'arrow') {
      previewEl = createLine(startX, startY, startX, startY);
      svg.appendChild(previewEl);
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drawing || !previewEl) return;
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;

    if (activeTool === 'circle') {
      const cx = (startX + curX) / 2;
      const cy = (startY + curY) / 2;
      const rx = Math.abs(curX - startX) / 2;
      const ry = Math.abs(curY - startY) / 2;
      previewEl.setAttribute('cx', cx);
      previewEl.setAttribute('cy', cy);
      previewEl.setAttribute('rx', rx);
      previewEl.setAttribute('ry', ry);
    } else if (activeTool === 'rect') {
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);
      previewEl.setAttribute('x', x);
      previewEl.setAttribute('y', y);
      previewEl.setAttribute('width', w);
      previewEl.setAttribute('height', h);
    } else if (activeTool === 'arrow') {
      previewEl.setAttribute('x2', curX);
      previewEl.setAttribute('y2', curY);
    }
  });

  svg.addEventListener('pointerup', (e) => {
    if (!drawing || !previewEl) return;
    e.preventDefault();
    drawing = false;

    const rect = svg.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const dist = Math.hypot(curX - startX, curY - startY);
    if (dist < 5) {
      previewEl.remove();
    } else {
      shapes.push(previewEl);
    }
    previewEl = null;
  });

  // Text tool: click to place input
  svg.addEventListener('click', (e) => {
    if (activeTool !== 'text') return;
    e.preventDefault();
    e.stopPropagation();

    const c = getColor();
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const fo = document.createElementNS(svgNS, 'foreignObject');
    fo.setAttribute('x', x);
    fo.setAttribute('y', y - FONT_SIZE - 4);
    fo.setAttribute('width', '300');
    fo.setAttribute('height', String(FONT_SIZE + 16));

    const input = document.createElement('input');
    Object.assign(input.style, {
      all: 'unset',
      font: `bold ${FONT_SIZE}px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`,
      color: c.hex,
      background: 'rgba(255,255,255,0.85)',
      border: `1.5px solid ${c.hex}`,
      borderRadius: '4px',
      padding: '2px 6px',
      outline: 'none',
      width: '280px',
      caretColor: c.hex,
    });

    fo.appendChild(input);
    svg.appendChild(fo);

    requestAnimationFrame(() => input.focus());

    function commit() {
      const val = input.value.trim();
      fo.remove();
      if (val) {
        const textEl = createText(x, y, val);
        svg.appendChild(textEl);
        shapes.push(textEl);
      }
    }

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); fo.remove(); }
      ev.stopPropagation();
    });
    input.addEventListener('blur', commit);
  });

  // --- Keyboard shortcuts (while overlay is active) ---
  document.addEventListener('keydown', function __tcAnnotateKeydown(e) {
    if (!document.getElementById(ROOT_ID)) {
      document.removeEventListener('keydown', __tcAnnotateKeydown);
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'c' || e.key === 'C') setActiveTool(activeTool === 'circle' ? null : 'circle');
    else if (e.key === 'r' || e.key === 'R') setActiveTool(activeTool === 'rect' ? null : 'rect');
    else if (e.key === 'a' || e.key === 'A') setActiveTool(activeTool === 'arrow' ? null : 'arrow');
    else if (e.key === 't' || e.key === 'T') setActiveTool(activeTool === 'text' ? null : 'text');
    else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const last = shapes.pop();
      if (last) last.remove();
    }
    else if (e.key === 'Escape') {
      if (activeTool) {
        setActiveTool(null);
      } else {
        root.remove();
        chrome.runtime.sendMessage({ type: 'annotate_done' }).catch(() => {});
      }
    }
    // Number keys 1-6 for color switching
    else if (e.key >= '1' && e.key <= '6') {
      setActiveColor(parseInt(e.key, 10) - 1);
    }
  });

  // --- Listen for toggle-off message from background ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'annotate_toggle_off') {
      const el = document.getElementById(ROOT_ID);
      if (el) el.remove();
    }
  });

  // Start with circle tool active
  setActiveTool('circle');
})();
