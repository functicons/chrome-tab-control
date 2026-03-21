// Tab Control — Annotation overlay (injected into shared tabs)
// Provides circle, rectangle, arrow, and text drawing tools on an SVG overlay.
// Annotations are visible in CDP screenshots so the AI agent can see them.

(function () {
  'use strict';

  const ROOT_ID = '__tc-annotate-root';

  // If overlay exists, check if it's dormant (Done was clicked) or active
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    if (existing.__tcReactivate) {
      // Dormant — reactivate
      existing.__tcReactivate();
      return;
    }
    // Active — remove entirely (toggle off)
    existing.remove();
    chrome.runtime.sendMessage({ type: 'annotate_done' }).catch(() => {});
    return;
  }

  // --- Constants ---
  const COLORS = [
    { id: 'red',    hex: '#e53935', fill: 'none' },
    { id: 'blue',   hex: '#1e88e5', fill: 'none' },
    { id: 'green',  hex: '#43a047', fill: 'none' },
    { id: 'orange', hex: '#fb8c00', fill: 'none' },
    { id: 'purple', hex: '#8e24aa', fill: 'none' },
    { id: 'black',  hex: '#212121', fill: 'none' },
  ];
  const STROKE_WIDTH = 4;
  const FONT_SIZE = 20;

  // --- State ---
  let activeTool = null; // 'select' | 'circle' | 'rect' | 'arrow' | 'text' | null
  let selectedShape = null;
  let movingShape = false;
  let moveStartX = 0, moveStartY = 0;
  let moveOrigAttrs = null; // original attributes before move
  let suppressNextClick = false; // prevent click after drag-move
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

  // --- Drag handle for moving toolbar ---
  const dragHandle = document.createElement('div');
  dragHandle.title = 'Drag to move';
  dragHandle.textContent = '⠿';
  Object.assign(dragHandle.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '32px',
    cursor: 'grab',
    color: '#aaa',
    fontSize: '16px',
    flexShrink: '0',
    marginRight: '2px',
  });
  toolbar.appendChild(dragHandle);

  let tbDragging = false;
  let tbDragOffsetX = 0, tbDragOffsetY = 0;
  let tbPositioned = false; // tracks if we've switched from centered to absolute positioning

  dragHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    tbDragging = true;
    dragHandle.style.cursor = 'grabbing';
    // Switch from center-transform positioning to direct left/top on first drag
    if (!tbPositioned) {
      tbPositioned = true;
      const rect = toolbar.getBoundingClientRect();
      toolbar.style.transform = 'none';
      toolbar.style.left = rect.left + 'px';
      toolbar.style.top = rect.top + 'px';
    }
    const rect = toolbar.getBoundingClientRect();
    tbDragOffsetX = e.clientX - rect.left;
    tbDragOffsetY = e.clientY - rect.top;
    dragHandle.setPointerCapture(e.pointerId);
  });

  dragHandle.addEventListener('pointermove', (e) => {
    if (!tbDragging) return;
    e.preventDefault();
    toolbar.style.left = (e.clientX - tbDragOffsetX) + 'px';
    toolbar.style.top = (e.clientY - tbDragOffsetY) + 'px';
  });

  dragHandle.addEventListener('pointerup', (e) => {
    if (!tbDragging) return;
    tbDragging = false;
    dragHandle.style.cursor = 'grab';
    dragHandle.releasePointerCapture(e.pointerId);
  });

  const ALL_TOOLS = ['circle', 'rect', 'arrow', 'text'];
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

  // --- Color picker (single swatch + dropdown) ---
  addSeparator();

  // The single swatch button shown in the toolbar
  const colorSwatch = document.createElement('button');
  colorSwatch.title = 'Color (1-6)';
  Object.assign(colorSwatch.style, {
    all: 'unset',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    cursor: 'pointer',
    background: COLORS[0].hex,
    border: 'none',
    boxShadow: '0 0 0 2px #fff, 0 0 0 3.5px rgba(0,0,0,0.2)',
    transition: 'transform 0.12s',
    boxSizing: 'border-box',
  });
  colorSwatch.addEventListener('mouseenter', () => { colorSwatch.style.transform = 'scale(1.1)'; });
  colorSwatch.addEventListener('mouseleave', () => { colorSwatch.style.transform = 'scale(1)'; });
  toolbar.appendChild(colorSwatch);

  // Dropdown panel (hidden by default)
  const colorDropdown = document.createElement('div');
  Object.assign(colorDropdown.style, {
    position: 'absolute',
    top: '100%',
    right: '0',
    marginTop: '6px',
    display: 'none',
    gap: '4px',
    background: '#fff',
    borderRadius: '8px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
    padding: '6px',
    pointerEvents: 'auto',
  });
  toolbar.style.position = 'fixed'; // already set, but ensure relative positioning for dropdown
  toolbar.appendChild(colorDropdown);

  const colorBtns = [];
  COLORS.forEach((color, idx) => {
    const btn = document.createElement('button');
    btn.title = `${color.id} (${idx + 1})`;
    Object.assign(btn.style, {
      all: 'unset',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '26px',
      height: '26px',
      borderRadius: '50%',
      cursor: 'pointer',
      background: color.hex,
      border: idx === 0 ? '2.5px solid #333' : '2.5px solid transparent',
      transition: 'border-color 0.12s, transform 0.12s',
      boxSizing: 'border-box',
    });
    btn.addEventListener('mouseenter', () => {
      if (activeColorIdx !== idx) btn.style.transform = 'scale(1.15)';
    });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveColor(idx);
      colorDropdown.style.display = 'none';
    });
    colorDropdown.appendChild(btn);
    colorBtns.push(btn);
  });

  colorSwatch.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = colorDropdown.style.display === 'flex';
    colorDropdown.style.display = isOpen ? 'none' : 'flex';
  });

  // Close dropdown when clicking elsewhere
  root.addEventListener('pointerdown', () => {
    colorDropdown.style.display = 'none';
  });

  // --- Minimize / expand button ---
  addSeparator();
  const minimizeBtn = document.createElement('button');
  minimizeBtn.title = 'Minimize (M)';
  minimizeBtn.textContent = '▾';
  Object.assign(minimizeBtn.style, btnStyle);
  minimizeBtn.addEventListener('mouseenter', () => { minimizeBtn.style.background = '#f0f0f0'; });
  minimizeBtn.addEventListener('mouseleave', () => { minimizeBtn.style.background = 'transparent'; });
  toolbar.appendChild(minimizeBtn);

  // Small floating button shown when toolbar is minimized
  const expandBtn = document.createElement('button');
  expandBtn.title = 'Expand toolbar (M)';
  expandBtn.textContent = '✏';
  Object.assign(expandBtn.style, {
    all: 'unset',
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
    cursor: 'pointer',
    fontSize: '18px',
    pointerEvents: 'auto',
    zIndex: '2147483647',
    transition: 'background 0.12s',
    userSelect: 'none',
  });
  expandBtn.addEventListener('mouseenter', () => { expandBtn.style.background = '#f0f0f0'; });
  expandBtn.addEventListener('mouseleave', () => { expandBtn.style.background = '#fff'; });
  root.appendChild(expandBtn);

  // --- Expand button drag-to-move ---
  let ebDragging = false;
  let ebDragOffsetX = 0, ebDragOffsetY = 0;
  let ebPositioned = false;
  let ebDragMoved = false;

  expandBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ebDragging = true;
    ebDragMoved = false;
    expandBtn.style.cursor = 'grabbing';
    if (!ebPositioned) {
      ebPositioned = true;
      const rect = expandBtn.getBoundingClientRect();
      expandBtn.style.transform = 'none';
      expandBtn.style.left = rect.left + 'px';
      expandBtn.style.top = rect.top + 'px';
    }
    const rect = expandBtn.getBoundingClientRect();
    ebDragOffsetX = e.clientX - rect.left;
    ebDragOffsetY = e.clientY - rect.top;
    expandBtn.setPointerCapture(e.pointerId);
  });

  expandBtn.addEventListener('pointermove', (e) => {
    if (!ebDragging) return;
    e.preventDefault();
    ebDragMoved = true;
    expandBtn.style.left = (e.clientX - ebDragOffsetX) + 'px';
    expandBtn.style.top = (e.clientY - ebDragOffsetY) + 'px';
  });

  expandBtn.addEventListener('pointerup', (e) => {
    if (!ebDragging) return;
    ebDragging = false;
    expandBtn.style.cursor = 'pointer';
    expandBtn.releasePointerCapture(e.pointerId);
    // Only toggle if it was a click, not a drag
    if (!ebDragMoved) toggleMinimize();
  });

  let minimized = false;
  function toggleMinimize() {
    minimized = !minimized;
    if (minimized) {
      // Position expand button at toolbar's current location
      const tbRect = toolbar.getBoundingClientRect();
      expandBtn.style.transform = 'none';
      expandBtn.style.left = tbRect.left + 'px';
      expandBtn.style.top = tbRect.top + 'px';
      ebPositioned = true;
    } else {
      // Position toolbar at expand button's current location
      const ebRect = expandBtn.getBoundingClientRect();
      toolbar.style.transform = 'none';
      toolbar.style.left = ebRect.left + 'px';
      toolbar.style.top = ebRect.top + 'px';
      tbPositioned = true;
    }
    toolbar.style.display = minimized ? 'none' : 'flex';
    expandBtn.style.display = minimized ? 'flex' : 'none';
  }
  minimizeBtn.addEventListener('click', toggleMinimize);

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
  // --- Selection highlight ---
  const selectionRect = document.createElementNS(svgNS, 'rect');
  selectionRect.setAttribute('fill', 'none');
  selectionRect.setAttribute('stroke', '#1a73e8');
  selectionRect.setAttribute('stroke-width', '1.5');
  selectionRect.setAttribute('stroke-dasharray', '5,3');
  selectionRect.setAttribute('pointer-events', 'none');
  selectionRect.style.display = 'none';
  svg.appendChild(selectionRect);

  function selectShape(el) {
    if (selectedShape === el) return;
    deselectShape();
    selectedShape = el;
    const bbox = el.getBBox();
    const pad = 6;
    selectionRect.setAttribute('x', bbox.x - pad);
    selectionRect.setAttribute('y', bbox.y - pad);
    selectionRect.setAttribute('width', bbox.width + pad * 2);
    selectionRect.setAttribute('height', bbox.height + pad * 2);
    selectionRect.setAttribute('rx', '3');
    selectionRect.style.display = '';
  }

  function deselectShape() {
    selectedShape = null;
    selectionRect.style.display = 'none';
  }

  function updateSelectionRect() {
    if (!selectedShape) return;
    const bbox = selectedShape.getBBox();
    const pad = 6;
    selectionRect.setAttribute('x', bbox.x - pad);
    selectionRect.setAttribute('y', bbox.y - pad);
    selectionRect.setAttribute('width', bbox.width + pad * 2);
    selectionRect.setAttribute('height', bbox.height + pad * 2);
  }

  function getShapeAttrs(el) {
    const tag = el.tagName;
    if (tag === 'ellipse') return { cx: +el.getAttribute('cx'), cy: +el.getAttribute('cy') };
    if (tag === 'rect') return { x: +el.getAttribute('x'), y: +el.getAttribute('y') };
    if (tag === 'line') return {
      x1: +el.getAttribute('x1'), y1: +el.getAttribute('y1'),
      x2: +el.getAttribute('x2'), y2: +el.getAttribute('y2'),
    };
    if (tag === 'text') return { x: +el.getAttribute('x'), y: +el.getAttribute('y') };
    // Arrow group (<g> with __tcLine)
    if (tag === 'g' && el.__tcLine) {
      const ln = el.__tcLine;
      return {
        x1: +ln.getAttribute('x1'), y1: +ln.getAttribute('y1'),
        x2: +ln.getAttribute('x2'), y2: +ln.getAttribute('y2'),
      };
    }
    return {};
  }

  function moveShapeBy(el, dx, dy) {
    const tag = el.tagName;
    if (tag === 'ellipse') {
      el.setAttribute('cx', moveOrigAttrs.cx + dx);
      el.setAttribute('cy', moveOrigAttrs.cy + dy);
    } else if (tag === 'rect') {
      el.setAttribute('x', moveOrigAttrs.x + dx);
      el.setAttribute('y', moveOrigAttrs.y + dy);
    } else if (tag === 'line') {
      el.setAttribute('x1', moveOrigAttrs.x1 + dx);
      el.setAttribute('y1', moveOrigAttrs.y1 + dy);
      el.setAttribute('x2', moveOrigAttrs.x2 + dx);
      el.setAttribute('y2', moveOrigAttrs.y2 + dy);
    } else if (tag === 'text') {
      el.setAttribute('x', moveOrigAttrs.x + dx);
      el.setAttribute('y', moveOrigAttrs.y + dy);
    } else if (tag === 'g' && el.__tcLine) {
      // Arrow group: move both the visible line and the hit area
      [el.__tcLine, el.__tcHitArea].forEach((ln) => {
        ln.setAttribute('x1', moveOrigAttrs.x1 + dx);
        ln.setAttribute('y1', moveOrigAttrs.y1 + dy);
        ln.setAttribute('x2', moveOrigAttrs.x2 + dx);
        ln.setAttribute('y2', moveOrigAttrs.y2 + dy);
      });
    }
  }

  function isSelectMode() { return !activeTool; }

  function setActiveTool(toolId) {
    activeTool = toolId;
    if (!isSelectMode()) deselectShape();
    ALL_TOOLS.forEach((id) => {
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
    // SVG always receives pointer events (null = select mode)
    svg.style.pointerEvents = 'all';
    svg.style.cursor = isSelectMode() ? 'default' : activeTool === 'text' ? 'text' : 'crosshair';
  }

  function setActiveColor(idx) {
    activeColorIdx = idx;
    colorSwatch.style.background = COLORS[idx].hex;
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
    el.setAttribute('pointer-events', 'all');
    el.setAttribute('data-tc-annotation', 'circle');
    el.setAttribute('data-tc-color', c.id);
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
    el.setAttribute('pointer-events', 'all');
    el.setAttribute('data-tc-annotation', 'rect');
    el.setAttribute('data-tc-color', c.id);
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
    el.setAttribute('pointer-events', 'stroke');
    return el;
  }

  // Wrap a line in a group with an invisible fat hit area for easier selection
  function createArrowGroup(x1, y1, x2, y2) {
    const c = getColor();
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('data-tc-annotation', 'arrow');
    g.setAttribute('data-tc-color', c.id);
    const hitArea = document.createElementNS(svgNS, 'line');
    hitArea.setAttribute('x1', x1);
    hitArea.setAttribute('y1', y1);
    hitArea.setAttribute('x2', x2);
    hitArea.setAttribute('y2', y2);
    hitArea.setAttribute('stroke', 'transparent');
    hitArea.setAttribute('stroke-width', '20');
    hitArea.setAttribute('pointer-events', 'stroke');
    const line = createLine(x1, y1, x2, y2);
    g.appendChild(hitArea);
    g.appendChild(line);
    g.__tcLine = line;
    g.__tcHitArea = hitArea;
    return g;
  }

  function createText(x, y, content) {
    const c = getColor();
    const el = document.createElementNS(svgNS, 'text');
    el.setAttribute('x', x);
    el.setAttribute('y', y);
    el.setAttribute('fill', c.hex);
    el.setAttribute('font-size', FONT_SIZE);
    el.setAttribute('data-tc-annotation', 'text');
    el.setAttribute('data-tc-color', c.id);
    el.setAttribute('font-weight', 'bold');
    el.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif");
    el.setAttribute('stroke', '#fff');
    el.setAttribute('stroke-width', '3');
    el.setAttribute('paint-order', 'stroke');
    el.setAttribute('pointer-events', 'all');
    el.textContent = content;
    return el;
  }

  // --- Tool button handlers ---
  ALL_TOOLS.forEach((id) => {
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

  function deactivateOverlay() {
    deselectShape();
    setActiveTool(null);
    toolbar.style.display = 'none';
    expandBtn.style.display = 'none';
    svg.style.pointerEvents = 'none';
    root.__tcReactivate = reactivateOverlay;
    chrome.runtime.sendMessage({ type: 'annotate_done' }).catch(() => {});
  }

  function reactivateOverlay() {
    minimized = false;
    toolbar.style.display = 'flex';
    expandBtn.style.display = 'none';
    svg.style.pointerEvents = 'all';
    delete root.__tcReactivate;
    setActiveTool('circle');
  }

  buttons.done.addEventListener('click', deactivateOverlay);

  // --- SVG drawing & select handlers ---
  svg.addEventListener('pointerdown', (e) => {
    const svgRect = svg.getBoundingClientRect();
    const px = e.clientX - svgRect.left;
    const py = e.clientY - svgRect.top;

    // --- Check if user clicked on an existing shape (works in any mode) ---
    let clickTarget = e.target;
    let foundShape = null;
    while (clickTarget && clickTarget !== svg) {
      if (shapes.includes(clickTarget)) { foundShape = clickTarget; break; }
      clickTarget = clickTarget.parentElement;
    }

    // If a shape was clicked, select and start moving it
    if (foundShape) {
      e.preventDefault();
      selectShape(foundShape);
      movingShape = true;
      moveStartX = px;
      moveStartY = py;
      moveOrigAttrs = getShapeAttrs(foundShape);
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = 'move';
      return;
    }

    // Clicked on empty space
    deselectShape();

    // In select mode, nothing more to do
    if (isSelectMode()) return;

    // --- Drawing tools ---
    if (activeTool === 'text') return;
    e.preventDefault();
    drawing = true;
    startX = px;
    startY = py;

    if (activeTool === 'circle') {
      previewEl = createEllipse(startX, startY, 0, 0);
      svg.appendChild(previewEl);
    } else if (activeTool === 'rect') {
      previewEl = createRect(startX, startY, 0, 0);
      svg.appendChild(previewEl);
    } else if (activeTool === 'arrow') {
      previewEl = createArrowGroup(startX, startY, startX, startY);
      svg.appendChild(previewEl);
    }
  });

  svg.addEventListener('pointermove', (e) => {
    const svgRect = svg.getBoundingClientRect();
    const curX = e.clientX - svgRect.left;
    const curY = e.clientY - svgRect.top;

    // --- Moving a selected shape ---
    if (movingShape && selectedShape) {
      e.preventDefault();
      const dx = curX - moveStartX;
      const dy = curY - moveStartY;
      moveShapeBy(selectedShape, dx, dy);
      updateSelectionRect();
      return;
    }

    // --- Drawing preview ---
    if (!drawing || !previewEl) return;
    e.preventDefault();

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
    } else if (activeTool === 'arrow' && previewEl.__tcLine) {
      previewEl.__tcLine.setAttribute('x2', curX);
      previewEl.__tcLine.setAttribute('y2', curY);
      previewEl.__tcHitArea.setAttribute('x2', curX);
      previewEl.__tcHitArea.setAttribute('y2', curY);
    }
  });

  svg.addEventListener('pointerup', (e) => {
    // --- End shape move ---
    if (movingShape) {
      movingShape = false;
      moveOrigAttrs = null;
      suppressNextClick = true;
      svg.releasePointerCapture(e.pointerId);
      svg.style.cursor = isSelectMode() ? 'default' : 'crosshair';
      return;
    }

    // --- End drawing ---
    if (!drawing || !previewEl) return;
    e.preventDefault();
    drawing = false;

    const svgRect = svg.getBoundingClientRect();
    const curX = e.clientX - svgRect.left;
    const curY = e.clientY - svgRect.top;
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
    if (suppressNextClick) { suppressNextClick = false; return; }
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

    let committed = false;
    function commit() {
      if (committed) return;
      committed = true;
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
      if (ev.key === 'Escape') { ev.preventDefault(); committed = true; fo.remove(); }
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
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedShape) {
      e.preventDefault();
      const idx = shapes.indexOf(selectedShape);
      if (idx !== -1) shapes.splice(idx, 1);
      selectedShape.remove();
      deselectShape();
    }
    else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const last = shapes.pop();
      if (last) last.remove();
    }
    else if (e.key === 'Escape') {
      if (selectedShape) {
        deselectShape();
      } else if (activeTool) {
        setActiveTool(null);
      } else {
        deactivateOverlay();
      }
    }
    // Number keys 1-6 for color switching
    else if (e.key >= '1' && e.key <= '6') {
      setActiveColor(parseInt(e.key, 10) - 1);
    }
    // M to toggle minimize
    else if (e.key === 'm' || e.key === 'M') {
      toggleMinimize();
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
