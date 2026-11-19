export function renderGraphUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Siftable Graph</title>
<style>
  :root {
    --bg: #090a0d;
    --bg-elev: #111318;
    --bg-card: #12151b;
    --bg-card-hover: #171b23;
    --bg-pill: #1c2028;
    --border: #232833;
    --border-strong: #323949;
    --text: #eef1f6;
    --text-muted: #8b95a7;
    --text-dim: #5e6778;
    --orange: #f97316;
    --orange-soft: rgba(249, 115, 22, 0.14);
    --orange-border: rgba(249, 115, 22, 0.72);
    --orange-glow: 0 0 0 1px rgba(249, 115, 22, 0.25), 0 8px 26px -10px rgba(249, 115, 22, 0.35);
    --amber: #f59e0b;
    --amber-soft: rgba(245, 158, 11, 0.14);
    --green: #22c55e;
    --green-soft: rgba(34, 197, 94, 0.14);
    --blue: #38bdf8;
    --blue-soft: rgba(56, 189, 248, 0.14);
    --red: #ef4444;
    --red-soft: rgba(239, 68, 68, 0.14);
    --radius: 12px;
    --font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--bg); color: var(--text); font-family: var(--font);
    font-size: 13px; -webkit-font-smoothing: antialiased;
  }
  button, input, textarea, select { font-family: inherit; color: inherit; }

  /* Layout */
  .app { display: flex; flex-direction: column; height: 100vh; }

  /* Topbar */
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: rgba(11, 13, 17, 0.94); backdrop-filter: blur(8px);
    z-index: 20; flex-shrink: 0;
  }
  .topbar-left { display: flex; align-items: center; gap: 10px; min-width: 110px; }
  .brand { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
  .mode-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 500;
    background: var(--bg-pill); border: 1px solid var(--border); color: var(--text-muted);
  }
  .mode-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
  .mode-chip.demo .mode-dot { background: var(--amber); }

  .nav-tabs { display: flex; align-items: center; gap: 6px; }
  .nav-tab {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 6px 12px; border-radius: 9px; border: 1px solid transparent;
    background: transparent; color: var(--text-muted); font-weight: 550;
    cursor: pointer; transition: all 120ms ease; font-size: 13px;
  }
  .nav-tab:hover { background: var(--bg-pill); color: var(--text); }
  .nav-tab.active {
    background: var(--orange-soft); border-color: rgba(249, 115, 22, 0.45);
    color: #fdba74;
  }
  .badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 18px; padding: 0 6px; border-radius: 999px;
    font-size: 11px; font-weight: 650; background: var(--orange); color: #160a02;
  }
  .badge.muted { background: #262b36; color: var(--text-muted); }

  .topbar-right { display: flex; align-items: center; gap: 8px; }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    height: 30px; padding: 0 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg-elev);
    color: var(--text-muted); cursor: pointer; font-size: 12px; font-weight: 500;
  }
  .icon-btn:hover { border-color: var(--border-strong); color: var(--text); background: var(--bg-pill); }
  .icon-btn.active { border-color: rgba(249, 115, 22, 0.5); color: #fdba74; background: var(--orange-soft); }
  .primary-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    height: 30px; padding: 0 12px; border-radius: 999px; border: none;
    background: var(--orange); color: #140902; font-weight: 650;
    cursor: pointer; font-size: 13px;
  }
  .primary-btn:hover { background: #fb923c; }
  .primary-btn.circle { width: 30px; padding: 0; font-size: 18px; line-height: 1; }

  /* Filter Toolbar */
  .toolbar {
    display: flex; align-items: center; gap: 8px; padding: 8px 16px;
    border-bottom: 1px solid var(--border); background: #0c0e12;
    flex-shrink: 0; flex-wrap: wrap;
  }
  .select-wrap {
    flex: 1; min-width: 180px; max-width: 480px; position: relative;
  }
  .select-wrap select, .filter-select {
    width: 100%; height: 32px; padding: 0 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg-elev); color: var(--text);
    font-size: 12.5px; outline: none; cursor: pointer;
  }
  .filter-select { width: auto; min-width: 130px; }
  .select-wrap select:focus, .filter-select:focus { border-color: var(--orange); }
  .toolbar-spacer { flex: 1; }
  .zoom-group { display: inline-flex; align-items: center; gap: 4px; }
  .zoom-label { font-family: var(--mono); font-size: 11px; color: var(--text-muted); min-width: 42px; text-align: center; }

  /* Demo Banner */
  .demo-banner {
    display: none; align-items: center; justify-content: space-between; gap: 12px;
    padding: 7px 16px; background: rgba(245, 158, 11, 0.09);
    border-bottom: 1px solid rgba(245, 158, 11, 0.28); color: #fcd34d; font-size: 12px;
    flex-shrink: 0;
  }
  .demo-banner.visible { display: flex; }
  .demo-banner code {
    font-family: var(--mono); background: rgba(0, 0, 0, 0.35); padding: 2px 6px;
    border-radius: 5px; color: #fde68a;
  }

  /* Main workspace */
  .workspace { position: relative; flex: 1; overflow: hidden; display: flex; }
  .view-pane { flex: 1; position: relative; overflow: hidden; display: none; }
  .view-pane.active { display: flex; flex-direction: column; }

  /* Dot-grid Graph Canvas */
  .canvas-viewport {
    flex: 1; position: relative; overflow: hidden; cursor: grab; user-select: none;
    background-color: var(--bg);
    background-image: radial-gradient(rgba(148, 163, 184, 0.14) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  .canvas-viewport.dragging { cursor: grabbing; }
  .canvas-stage {
    position: absolute; top: 0; left: 0; transform-origin: 0 0;
  }
  .edges-layer {
    position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none;
  }
  .nodes-layer { position: absolute; top: 0; left: 0; }

  /* Graph Node Card */
  .node-card {
    position: absolute; width: 276px; min-height: 112px;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 12px 14px 11px;
    display: flex; flex-direction: column; justify-content: space-between; gap: 10px;
    cursor: pointer; transition: border-color 140ms ease, transform 120ms ease, box-shadow 140ms ease;
    box-shadow: 0 6px 20px -10px rgba(0, 0, 0, 0.8);
  }
  .node-card:hover {
    background: var(--bg-card-hover); border-color: var(--border-strong);
    transform: translateY(-1px);
  }
  .node-card.frontier {
    border-color: var(--orange-border);
    box-shadow: var(--orange-glow);
  }
  .node-card.selected {
    border-color: #fb923c;
    box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.38), 0 12px 30px -10px rgba(0, 0, 0, 0.85);
  }
  .node-card.done { opacity: 0.78; border-color: rgba(34, 197, 94, 0.34); }
  .node-card.cancelled { opacity: 0.5; }
  .node-card.failed { border-color: rgba(239, 68, 68, 0.65); }

  .node-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .node-kind {
    font-size: 10.5px; font-weight: 650; letter-spacing: 0.08em;
    color: var(--text-dim); text-transform: uppercase;
  }
  .status-pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: var(--bg-pill); color: var(--text-muted); border: 1px solid var(--border);
    white-space: nowrap;
  }
  .status-pill.ready {
    background: var(--orange-soft); color: #fdba74; border-color: rgba(249, 115, 22, 0.4);
  }
  .status-pill.needs_you {
    background: var(--amber-soft); color: #fcd34d; border-color: rgba(245, 158, 11, 0.45);
  }
  .status-pill.active {
    background: var(--blue-soft); color: #7dd3fc; border-color: rgba(56, 189, 248, 0.45);
  }
  .status-pill.done {
    background: var(--green-soft); color: #86efac; border-color: rgba(34, 197, 94, 0.35);
  }
  .status-pill.failed {
    background: var(--red-soft); color: #fca5a5; border-color: rgba(239, 68, 68, 0.45);
  }

  .node-title {
    font-size: 13.5px; font-weight: 600; line-height: 1.35; color: var(--text);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .node-footer {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.04);
    font-size: 11.5px; color: var(--text-dim);
  }
  .node-meta { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; }
  .unblocks-tag { color: var(--orange); font-weight: 600; white-space: nowrap; }

  /* Next & Tasks Views */
  .scroll-pane {
    flex: 1; overflow-y: auto; padding: 20px 24px 40px;
    max-width: 980px; width: 100%; margin: 0 auto;
  }
  .section-heading {
    display: flex; align-items: center; justify-content: space-between;
    margin: 0 0 12px; font-size: 12px; font-weight: 650; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--text-muted);
  }
  .next-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 24px; }
  .next-row {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    padding: 13px 16px; border-radius: var(--radius);
    background: var(--bg-card); border: 1px solid var(--border);
    cursor: pointer; transition: border-color 120ms ease;
  }
  .next-row:hover { border-color: var(--orange-border); background: var(--bg-card-hover); }
  .next-row-main { min-width: 0; flex: 1; }
  .next-row-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .next-row-sub { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .next-row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

  .tasks-table { width: 100%; border-collapse: collapse; }
  .tasks-table th, .tasks-table td {
    text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border);
  }
  .tasks-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); }
  .tasks-table tr:hover td { background: rgba(255, 255, 255, 0.025); cursor: pointer; }

  /* Detail Slide-over Drawer */
  .drawer {
    position: absolute; top: 0; right: 0; bottom: 0;
    width: min(440px, 92vw); background: #0e1015;
    border-left: 1px solid var(--border);
    display: flex; flex-direction: column; z-index: 30;
    transform: translateX(100%); transition: transform 170ms cubic-bezier(0.2, 0.8, 0.2, 1);
    box-shadow: -16px 0 40px rgba(0, 0, 0, 0.6);
  }
  .drawer.open { transform: translateX(0); }
  .drawer-header {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
    padding: 14px 16px; border-bottom: 1px solid var(--border);
  }
  .drawer-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  .drawer-title { font-size: 16px; font-weight: 650; line-height: 1.3; margin: 6px 0 4px; }
  .drawer-id { font-family: var(--mono); font-size: 11px; color: var(--text-dim); }

  .card-box {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px;
  }
  .card-box.fork-box { border-color: rgba(249, 115, 22, 0.32); }
  .card-box-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--text-muted);
  }
  .branch-item {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
    background: #0b0d12; margin-top: 6px; cursor: pointer;
  }
  .branch-item:hover { border-color: var(--border-strong); background: #141821; }
  .branch-title { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .breadcrumb-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .crumb {
    font-size: 11.5px; padding: 3px 8px; border-radius: 6px;
    background: var(--bg-pill); border: 1px solid var(--border); color: var(--text-muted);
    cursor: pointer;
  }
  .crumb:hover { border-color: var(--orange-border); color: var(--text); }

  .handback-summary {
    font-size: 12.5px; line-height: 1.5; color: var(--text);
    background: rgba(34, 197, 94, 0.06); border: 1px solid rgba(34, 197, 94, 0.25);
    border-radius: 8px; padding: 10px 12px; white-space: pre-wrap;
  }
  .artifact-pre {
    margin: 8px 0 0; padding: 10px; border-radius: 8px;
    background: #07080b; border: 1px solid var(--border);
    font-family: var(--mono); font-size: 11.5px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto;
  }

  .action-bar { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn {
    height: 30px; padding: 0 11px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg-pill);
    color: var(--text); font-size: 12px; font-weight: 550; cursor: pointer;
  }
  .btn:hover { border-color: var(--border-strong); background: #232834; }
  .btn.accept { background: var(--green-soft); border-color: rgba(34, 197, 94, 0.45); color: #86efac; }
  .btn.accept:hover { background: rgba(34, 197, 94, 0.22); }
  .btn.danger { background: var(--red-soft); border-color: rgba(239, 68, 68, 0.4); color: #fca5a5; }
  .btn.orange { background: var(--orange-soft); border-color: rgba(249, 115, 22, 0.5); color: #fdba74; }

  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
  .field label { font-size: 11.5px; color: var(--text-muted); font-weight: 550; }
  .field input, .field textarea, .field select {
    width: 100%; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: #0a0c10; color: var(--text);
    font-size: 12.5px; outline: none;
  }
  .field input:focus, .field textarea:focus { border-color: var(--orange); }

  /* Modal */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.72);
    display: none; align-items: center; justify-content: center; z-index: 50; padding: 16px;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    width: min(500px, 100%); background: #10131a; border: 1px solid var(--border-strong);
    border-radius: 14px; padding: 18px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.8);
  }
  .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .modal-head h3 { margin: 0; font-size: 15px; }

  /* Toast */
  .toast {
    position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    padding: 8px 14px; border-radius: 999px; background: #1c222d;
    border: 1px solid var(--border-strong); color: var(--text); font-size: 12.5px;
    z-index: 60; opacity: 0; pointer-events: none; transition: opacity 160ms ease;
  }
  .toast.visible { opacity: 1; }

  .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; gap: 10px; color: var(--text-muted); text-align: center; padding: 32px;
  }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="topbar-left">
      <span class="brand" id="viewTitle">Graph</span>
      <span class="mode-chip" id="modeChip"><span class="mode-dot"></span><span id="modeText">Connecting</span></span>
    </div>
    <nav class="nav-tabs">
      <button class="nav-tab" data-tab="next">Next <span class="badge" id="badgeNext">0</span></button>
      <button class="nav-tab" data-tab="tasks">Tasks <span class="badge muted" id="badgeTasks">0</span></button>
      <button class="nav-tab active" data-tab="graph">Graph <span class="badge" id="badgeGraph">0</span></button>
    </nav>
    <div class="topbar-right">
      <button class="icon-btn active" id="pollToggle" title="Auto-refresh every 3s">Live</button>
      <button class="icon-btn" id="refreshBtn" title="Refresh now">↻</button>
      <button class="primary-btn circle" id="createBtn" title="Create work item">+</button>
    </div>
  </header>

  <div class="demo-banner" id="demoBanner">
    <span><strong>Demo Graph</strong> — local Siftable API unreachable. Start it with <code>npm run local</code> to connect live.</span>
    <button class="icon-btn" id="retryLiveBtn">Retry Live</button>
  </div>

  <div class="toolbar">
    <div class="select-wrap">
      <select id="rootSelect" aria-label="Filter by root"></select>
    </div>
    <select id="projectSelect" class="filter-select" style="display:none" aria-label="Filter by project"></select>
    <button class="icon-btn" id="frontierOnlyBtn">Frontier only</button>
    <div class="toolbar-spacer"></div>
    <div class="zoom-group" id="zoomControls">
      <button class="icon-btn" id="zoomOutBtn">−</button>
      <span class="zoom-label" id="zoomLabel">100%</span>
      <button class="icon-btn" id="zoomInBtn">+</button>
      <button class="icon-btn" id="fitBtn">Fit</button>
    </div>
  </div>

  <main class="workspace">
    <section class="view-pane active" id="pane-graph">
      <div class="canvas-viewport" id="viewport">
        <div class="canvas-stage" id="stage">
          <svg class="edges-layer" id="edgesLayer"></svg>
          <div class="nodes-layer" id="nodesLayer"></div>
        </div>
        <div class="empty-state" id="graphEmpty" style="display:none">
          <div>No work items yet.</div>
          <button class="primary-btn" id="emptyCreateBtn">+ Create root work item</button>
        </div>
      </div>
    </section>

    <section class="view-pane" id="pane-next">
      <div class="scroll-pane" id="nextContainer"></div>
    </section>

    <section class="view-pane" id="pane-tasks">
      <div class="scroll-pane" id="tasksContainer"></div>
    </section>

    <aside class="drawer" id="drawer">
      <div class="drawer-header">
        <div style="min-width:0;flex:1">
          <div id="drawerStatusRow" style="display:flex;align-items:center;gap:8px"></div>
          <div class="drawer-title" id="drawerTitle"></div>
          <div class="drawer-id" id="drawerId"></div>
        </div>
        <button class="icon-btn" id="closeDrawerBtn">✕</button>
      </div>
      <div class="drawer-body" id="drawerBody"></div>
    </aside>
  </main>
</div>

<div class="modal-backdrop" id="createModal">
  <div class="modal">
    <div class="modal-head">
      <h3>Create Work Item</h3>
      <button class="icon-btn" id="closeCreateModal">✕</button>
    </div>
    <form id="createForm">
      <div class="field">
        <label for="newTitle">Title</label>
        <input id="newTitle" required maxlength="500" placeholder="e.g. Implement parser edge cases" />
      </div>
      <div class="field">
        <label for="newDesc">Description</label>
        <textarea id="newDesc" rows="3" placeholder="Context, scope, and expected handback..."></textarea>
      </div>
      <div class="field">
        <label for="newStep">Primary verification step</label>
        <input id="newStep" value="Verify result and record handback summary" required />
      </div>
      <div class="field">
        <label for="newDep">Depends on (optional)</label>
        <select id="newDep"><option value="">None (new root)</option></select>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
        <button type="button" class="btn" id="cancelCreateModal">Cancel</button>
        <button type="submit" class="primary-btn">Create</button>
      </div>
    </form>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(() => {
  const CARD_W = 276;
  const CARD_H = 114;
  const COL_GAP = 42;
  const ROW_GAP = 72;

  const state = {
    tab: 'graph',
    mode: 'live',
    graph: null,
    projects: [],
    selectedRootId: '',
    selectedProjectId: '',
    frontierOnly: false,
    selectedWorkId: null,
    selectedDetail: null,
    expandedArtifacts: {},
    activeAction: null,
    fallbackPromptText: '',
    autoPoll: true,
    transform: { x: 40, y: 40, scale: 1 },
    hasFittedOnce: false,
  };

  const $ = (id) => document.getElementById(id);

  function esc(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 2400);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message || body?.error || 'Request failed');
    return body;
  }

  function statusLabel(node) {
    if (node.uiState === 'waiting') return \`Waiting \${node.waiting.satisfied}/\${node.waiting.total}\`;
    if (node.uiState === 'ready') return 'Ready';
    if (node.uiState === 'needs_you') return node.status === 'blocked' ? 'Blocked' : 'Needs you';
    if (node.uiState === 'active') return node.status === 'running' ? 'Running' : 'Claimed';
    if (node.uiState === 'done') return 'Done';
    if (node.uiState === 'failed') return 'Failed';
    if (node.uiState === 'cancelled') return 'Cancelled';
    return node.status;
  }

  function coverageText(node) {
    const c = node.coverage;
    if (!c) return \`v\${node.planVersion}\`;
    if (c.state === 'commands_passed') return \`v\${node.planVersion} · passed\`;
    if (c.state === 'failed') return \`v\${node.planVersion} · failed\`;
    return \`v\${node.planVersion} · \${c.passedRequiredCount}/\${c.requiredCount} steps\`;
  }

  function computeLayout(nodes, edges) {
    if (!nodes.length) return { positions: new Map(), width: 0, height: 0 };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const layers = new Map();
    let maxDepth = 0;
    for (const n of nodes) {
      maxDepth = Math.max(maxDepth, n.depth);
      const list = layers.get(n.depth) || [];
      list.push(n);
      layers.set(n.depth, list);
    }

    // Order depth 0 deterministically, then order deeper layers by parent barycenter.
    const orderIdx = new Map();
    const firstLayer = layers.get(0) || [];
    firstLayer.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    firstLayer.forEach((n, i) => orderIdx.set(n.id, i));

    for (let d = 1; d <= maxDepth; d++) {
      const layer = layers.get(d) || [];
      layer.sort((a, b) => {
        const avg = (node) => {
          const parents = node.dependentIds.filter((pid) => orderIdx.has(pid));
          if (!parents.length) return 9999;
          return parents.reduce((sum, pid) => sum + orderIdx.get(pid), 0) / parents.length;
        };
        const diff = avg(a) - avg(b);
        if (Math.abs(diff) > 0.001) return diff;
        return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      });
      layer.forEach((n, i) => orderIdx.set(n.id, i));
    }

    // Measure widest row to center all rows cleanly.
    let maxRowWidth = 0;
    for (let d = 0; d <= maxDepth; d++) {
      const count = (layers.get(d) || []).length;
      if (count > 0) {
        maxRowWidth = Math.max(maxRowWidth, count * CARD_W + (count - 1) * COL_GAP);
      }
    }

    const positions = new Map();
    const padX = 60;
    const padY = 48;
    for (let d = 0; d <= maxDepth; d++) {
      const layer = layers.get(d) || [];
      const rowW = layer.length * CARD_W + Math.max(0, layer.length - 1) * COL_GAP;
      const startX = padX + (maxRowWidth - rowW) / 2;
      const y = padY + d * (CARD_H + ROW_GAP);
      layer.forEach((n, i) => {
        positions.set(n.id, { x: startX + i * (CARD_W + COL_GAP), y });
      });
    }

    const totalW = maxRowWidth + padX * 2;
    const totalH = (maxDepth + 1) * CARD_H + maxDepth * ROW_GAP + padY * 2;
    return { positions, width: totalW, height: totalH };
  }

  function applyTransform() {
    const { x, y, scale } = state.transform;
    $('stage').style.transform = \`translate(\${x}px, \${y}px) scale(\${scale})\`;
    $('zoomLabel').textContent = \`\${Math.round(scale * 100)}%\`;
  }

  function fitToView(layout) {
    const vp = $('viewport');
    if (!layout || !layout.width || !vp.clientWidth) return;
    const margin = 36;
    const sx = (vp.clientWidth - margin * 2) / layout.width;
    const sy = (vp.clientHeight - margin * 2) / layout.height;
    const scale = Math.max(0.35, Math.min(1.05, sx, sy));
    const x = Math.max(margin, (vp.clientWidth - layout.width * scale) / 2);
    const y = Math.max(24, (vp.clientHeight - layout.height * scale) / 2);
    state.transform = { x, y, scale };
    applyTransform();
  }

  let lastLayout = null;

  function visibleGraphData() {
    const g = state.graph;
    if (!g) return { nodes: [], edges: [] };
    if (!state.frontierOnly) return { nodes: g.nodes, edges: g.edges };
    const keep = new Set();
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const n of g.nodes) {
      if (n.uiState === 'ready' || n.uiState === 'needs_you' || n.uiState === 'active') {
        keep.add(n.id);
        for (const dep of n.dependentIds) keep.add(dep);
      }
    }
    return {
      nodes: g.nodes.filter((n) => keep.has(n.id)),
      edges: g.edges.filter((e) => keep.has(e.workId) && keep.has(e.predecessorId)),
    };
  }

  function renderGraph() {
    const { nodes, edges } = visibleGraphData();
    const emptyEl = $('graphEmpty');
    const nodesLayer = $('nodesLayer');
    const edgesLayer = $('edgesLayer');

    if (!nodes.length) {
      nodesLayer.innerHTML = '';
      edgesLayer.innerHTML = '';
      emptyEl.style.display = 'flex';
      return;
    }
    emptyEl.style.display = 'none';

    const layout = computeLayout(nodes, edges);
    lastLayout = layout;
    edgesLayer.setAttribute('width', String(layout.width));
    edgesLayer.setAttribute('height', String(layout.height));

    // Render smooth cubic Bezier curves from parent bottom to child top.
    const paths = [];
    // Draw inactive edges first, active orange edges on top.
    const sortedEdges = [...edges].sort((a, b) => Number(a.active) - Number(b.active));
    for (const e of sortedEdges) {
      const parentPos = layout.positions.get(e.workId);
      const childPos = layout.positions.get(e.predecessorId);
      if (!parentPos || !childPos) continue;
      const x1 = parentPos.x + CARD_W / 2;
      const y1 = parentPos.y + CARD_H;
      const x2 = childPos.x + CARD_W / 2;
      const y2 = childPos.y;
      const dy = Math.max(32, Math.abs(y2 - y1) * 0.55);
      const d = \`M \${x1} \${y1} C \${x1} \${y1 + dy}, \${x2} \${y2 - dy}, \${x2} \${y2}\`;
      const stroke = e.active
        ? '#f97316'
        : e.satisfied
          ? 'rgba(34, 197, 94, 0.45)'
          : '#2b313d';
      const width = e.active ? 2.2 : 1.4;
      const dash = e.gate === 'commands_passed' ? ' stroke-dasharray="5 4"' : '';
      paths.push(
        \`<path d="\${d}" fill="none" stroke="\${stroke}" stroke-width="\${width}"\${dash} stroke-linecap="round" />\`,
      );
    }
    edgesLayer.innerHTML = paths.join('');

    nodesLayer.innerHTML = nodes
      .map((n) => {
        const pos = layout.positions.get(n.id);
        const isFrontier = n.uiState === 'ready' || n.uiState === 'needs_you';
        const cls = [
          'node-card',
          isFrontier ? 'frontier' : '',
          n.uiState === 'done' ? 'done' : '',
          n.uiState === 'cancelled' ? 'cancelled' : '',
          n.uiState === 'failed' ? 'failed' : '',
          state.selectedWorkId === n.id ? 'selected' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const artBadge = n.artifactCount > 0 ? \` · \${n.artifactCount} art\` : '';
        const unblocksHtml =
          n.unblocksCount > 0
            ? \`<span class="unblocks-tag">unblocks \${n.unblocksCount}</span>\`
            : \`<span>\${n.isRoot ? 'root' : ''}</span>\`;
        return \`<div class="\${cls}" data-id="\${esc(n.id)}" style="left:\${pos.x}px;top:\${pos.y}px">
          <div class="node-top">
            <span class="node-kind">\${n.kind === 'leaf' ? 'LEAF' : 'THREAD'}</span>
            <span class="status-pill \${esc(n.uiState)}">\${esc(statusLabel(n))}</span>
          </div>
          <div class="node-title">\${esc(n.title)}</div>
          <div class="node-footer">
            <span class="node-meta">\${esc(coverageText(n))}\${artBadge}</span>
            \${unblocksHtml}
          </div>
        </div>\`;
      })
      .join('');

    nodesLayer.querySelectorAll('.node-card').forEach((card) => {
      card.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openDetail(card.getAttribute('data-id'));
      });
    });

    if (!state.hasFittedOnce) {
      state.hasFittedOnce = true;
      fitToView(layout);
    } else {
      applyTransform();
    }
  }

  function renderNext() {
    const g = state.graph;
    const el = $('nextContainer');
    if (!g) { el.innerHTML = ''; return; }
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const items = g.next.map((id) => byId.get(id)).filter(Boolean);
    const needsYou = items.filter((n) => n.uiState === 'needs_you');
    const ready = items.filter((n) => n.uiState === 'ready');

    const renderGroup = (title, list) => {
      if (!list.length) return '';
      return \`<div class="section-heading"><span>\${esc(title)}</span><span>\${list.length}</span></div>
        <div class="next-list">\${list
          .map(
            (n) => \`<div class="next-row" data-id="\${esc(n.id)}">
              <div class="next-row-main">
                <div class="next-row-title">\${esc(n.title)}</div>
                <div class="next-row-sub">\${esc(n.summary || n.description || 'No description')}</div>
              </div>
              <div class="next-row-actions">
                \${n.unblocksCount > 0 ? \`<span class="unblocks-tag">unblocks \${n.unblocksCount}</span>\` : ''}
                <span class="status-pill \${esc(n.uiState)}">\${esc(statusLabel(n))}</span>
                <button class="btn orange" data-copy="\${esc(n.id)}">Copy prompt</button>
              </div>
            </div>\`,
          )
          .join('')}</div>\`;
    };

    if (!items.length) {
      el.innerHTML = '<div class="empty-state">All frontier work is settled or running.</div>';
      return;
    }

    el.innerHTML =
      renderGroup('Needs you (Review / Blocked)', needsYou) +
      renderGroup('Ready to claim (Unblocked frontier)', ready);

    el.querySelectorAll('.next-row').forEach((row) => {
      row.addEventListener('click', () => openDetail(row.getAttribute('data-id')));
    });
    el.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyAgentPrompt(btn.getAttribute('data-copy'));
      });
    });
  }

  function renderTasks() {
    const g = state.graph;
    const el = $('tasksContainer');
    if (!g || !g.nodes.length) {
      el.innerHTML = '<div class="empty-state">No work items found.</div>';
      return;
    }
    el.innerHTML = \`<table class="tasks-table">
      <thead><tr><th>Work Item</th><th>Status</th><th>Waiting</th><th>Unblocks</th><th>Plan</th></tr></thead>
      <tbody>\${g.nodes
        .map(
          (n) => \`<tr data-id="\${esc(n.id)}">
            <td><strong>\${esc(n.title)}</strong></td>
            <td><span class="status-pill \${esc(n.uiState)}">\${esc(statusLabel(n))}</span></td>
            <td style="font-family:var(--mono);color:var(--text-muted)">\${n.waiting.total ? \`\${n.waiting.satisfied}/\${n.waiting.total}\` : 'leaf'}</td>
            <td>\${n.unblocksCount > 0 ? \`<span class="unblocks-tag">\${n.unblocksCount}</span>\` : '—'}</td>
            <td style="font-family:var(--mono);color:var(--text-dim)">\${esc(coverageText(n))}</td>
          </tr>\`,
        )
        .join('')}</tbody>
    </table>\`;
    el.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => openDetail(tr.getAttribute('data-id')));
    });
  }

  function renderSelectors() {
    const g = state.graph;
    if (!g) return;
    const rootSel = $('rootSelect');
    const prev = state.selectedRootId;
    const opts = [\`<option value="">All roots (\${g.roots.length})</option>\`];
    for (const r of g.roots) {
      const activeBadge = r.needsYouCount + r.readyCount > 0 ? \` · \${r.needsYouCount + r.readyCount} next\` : '';
      opts.push(
        \`<option value="\${esc(r.id)}"\${r.id === prev ? ' selected' : ''}>\${esc(r.title)} · \${r.totalNodes}\${activeBadge}</option>\`,
      );
    }
    rootSel.innerHTML = opts.join('');

    const projSel = $('projectSelect');
    if (state.projects.length > 0) {
      projSel.style.display = 'block';
      projSel.innerHTML =
        '<option value="">All projects</option>' +
        state.projects
          .map(
            (p) =>
              \`<option value="\${esc(p.id)}"\${p.id === state.selectedProjectId ? ' selected' : ''}>\${esc(p.title)}</option>\`,
          )
          .join('');
    } else {
      projSel.style.display = 'none';
    }

    $('badgeNext').textContent = String(g.counts.next);
    $('badgeTasks').textContent = String(g.counts.total);
    $('badgeGraph').textContent = String(g.counts.total);
  }

  function buildAgentPrompt(node, detail) {
    const g = state.graph;
    const byId = new Map((g?.nodes || []).map((n) => [n.id, n]));
    const predSummaries = (node.predecessorIds || [])
      .map((pid) => byId.get(pid))
      .filter(Boolean)
      .map((p) => \`- \${p.title} (\${p.status}): \${p.summary || 'No summary'}\`)
      .join('\\n');
    const steps = (detail?.plan?.steps || [])
      .map((s) => \`- [\${s.required ? 'required' : 'optional'}] \${s.title} (stepId: \${s.id})\`)
      .join('\\n');
    return [
      \`Work on Siftable work item: \${node.title}\`,
      \`Work ID: \${node.id}\`,
      node.description ? \`\\nDescription:\\n\${node.description}\` : '',
      predSummaries ? \`\\nPredecessor Handbacks:\\n\${predSummaries}\` : '',
      steps ? \`\\nVerification Plan (v\${detail.plan.version}):\\n\${steps}\` : '',
      \`\\nWorkflow via Siftable MCP:\`,
      \`1. work_claim (id: "\${node.id}") -> work_start\`,
      \`2. Do the work, or if it splits into parallel sub-tasks, call work_block then work_fork\`,
      \`3. Record a handback summary via work_artifacts_add (name: "handback-summary.md")\`,
      \`4. Record verification evidence via work_evidence and submit via work_review\`,
    ]
      .filter(Boolean)
      .join('\\n');
  }

  async function copyAgentPrompt(id) {
    const node = state.graph?.nodes.find((n) => n.id === id);
    if (!node) return;
    let detail = state.selectedDetail?.id === id ? state.selectedDetail : null;
    if (!detail) {
      try {
        const res = await api(\`/api/work/\${encodeURIComponent(id)}\`);
        detail = res.data;
      } catch {
        detail = null;
      }
    }
    const text = buildAgentPrompt(node, detail);
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied Antigravity agent prompt');
    } catch {
      state.fallbackPromptText = text;
      state.activeAction = 'prompt';
      if (state.selectedWorkId !== id) {
        await openDetail(id);
        state.activeAction = 'prompt';
      }
      renderDrawer();
      showToast('Clipboard unavailable — select & copy below');
    }
  }

  async function openDetail(id) {
    if (!id) return;
    state.selectedWorkId = id;
    state.activeAction = null;
    $('drawer').classList.add('open');
    renderGraph();
    try {
      const res = await api(\`/api/work/\${encodeURIComponent(id)}\`);
      state.selectedDetail = res.data;
      renderDrawer();
    } catch (err) {
      showToast(err.message);
    }
  }

  function renderDrawer() {
    const d = state.selectedDetail;
    const node = state.graph?.nodes.find((n) => n.id === state.selectedWorkId);
    if (!d || !node) return;
    const byId = new Map(state.graph.nodes.map((n) => [n.id, n]));

    $('drawerStatusRow').innerHTML =
      \`<span class="node-kind">\${node.kind === 'leaf' ? 'LEAF' : 'THREAD'}</span>\` +
      \`<span class="status-pill \${esc(node.uiState)}">\${esc(statusLabel(node))}</span>\` +
      (node.unblocksCount > 0 ? \`<span class="unblocks-tag">unblocks \${node.unblocksCount}</span>\` : '');
    $('drawerTitle').textContent = d.title;
    $('drawerId').textContent = \`\${d.id} · rev \${d.revision} · plan v\${d.plan_version}\`;

    const parts = [];

    // Upstream dependents breadcrumb
    if (node.dependentIds.length > 0) {
      const crumbs = node.dependentIds
        .map((pid) => byId.get(pid))
        .filter(Boolean)
        .map((p) => \`<button class="crumb" data-jump="\${esc(p.id)}">↑ \${esc(p.title)}</button>\`)
        .join('');
      parts.push(\`<div><div class="card-box-head"><span>Unblocks</span></div><div class="breadcrumb-row">\${crumbs}</div></div>\`);
    }

    if (d.description) {
      parts.push(\`<div class="card-box"><div class="card-box-head"><span>Description</span></div><div style="line-height:1.5;white-space:pre-wrap;color:var(--text)">\${esc(d.description)}</div></div>\`);
    }

    // Actions bar
    const canAccept = d.status === 'needs_review' && d.coverage?.state === 'commands_passed';
    const canRequeue = ['blocked', 'failed', 'needs_review', 'cancelled'].includes(d.status);
    const canFork = d.status === 'queued' || d.status === 'blocked';
    const canCancel = !['done', 'cancelled', 'failed'].includes(d.status);

    parts.push(\`<div class="action-bar">
      <button class="btn orange" id="drawerCopyPrompt">Copy Antigravity Prompt</button>
      \${canAccept ? '<button class="btn accept" id="drawerAcceptBtn">✓ Accept</button>' : ''}
      \${canFork ? '<button class="btn" id="drawerForkToggle">+ Fork branches</button>' : ''}
      \${canRequeue ? '<button class="btn" id="drawerRequeueBtn">↻ Reopen / Requeue</button>' : ''}
      \${canCancel ? '<button class="btn danger" id="drawerCancelBtn">Cancel</button>' : ''}
    </div>\`);

    // Inline action forms (no browser modal dialogs — works cleanly inside sandboxed webviews)
    if (state.activeAction === 'accept' && canAccept) {
      parts.push(\`<div class="card-box" style="border-color:rgba(34,197,94,0.45)">
        <div class="card-box-head"><span>Accept work item</span></div>
        <form id="acceptForm">
          <div class="field">
            <label for="acceptSummary">Acceptance summary</label>
            <textarea id="acceptSummary" rows="3" required>\${esc(d.summary || 'Accepted after review')}</textarea>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn" id="cancelActionBtn">Cancel</button>
            <button type="submit" class="btn accept" id="confirmAcceptBtn">✓ Confirm Accept</button>
          </div>
        </form>
      </div>\`);
    } else if (state.activeAction === 'requeue' && canRequeue) {
      parts.push(\`<div class="card-box" style="border-color:rgba(245,158,11,0.45)">
        <div class="card-box-head"><span>Reopen / Requeue work item</span></div>
        <form id="requeueForm">
          <div class="field">
            <label for="requeueReason">Reason</label>
            <input id="requeueReason" value="Reopened for follow-up" required />
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn" id="cancelActionBtn">Cancel</button>
            <button type="submit" class="btn orange">↻ Confirm Requeue</button>
          </div>
        </form>
      </div>\`);
    } else if (state.activeAction === 'cancel' && canCancel) {
      parts.push(\`<div class="card-box" style="border-color:rgba(239,68,68,0.45)">
        <div class="card-box-head"><span>Cancel work item</span></div>
        <form id="cancelWorkForm">
          <div class="field">
            <label for="cancelReason">Cancel reason</label>
            <input id="cancelReason" value="Superseded" required />
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn" id="cancelActionBtn">Keep open</button>
            <button type="submit" class="btn danger">Confirm Cancel</button>
          </div>
        </form>
      </div>\`);
    } else if (state.activeAction === 'fork' && canFork) {
      parts.push(\`<div class="card-box fork-box">
        <div class="card-box-head"><span>Fork child branches (one per line)</span></div>
        <form id="forkForm">
          <div class="field">
            <textarea id="forkLines" rows="3" required placeholder="Core matching semantics&#10;Scope and order syntax"></textarea>
          </div>
          <div class="field">
            <label for="forkReason">Reason</label>
            <input id="forkReason" value="Split into parallel branches" required />
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="btn" id="cancelActionBtn">Cancel</button>
            <button type="submit" class="primary-btn">Create Fork</button>
          </div>
        </form>
      </div>\`);
    } else if (state.activeAction === 'prompt' && state.fallbackPromptText) {
      parts.push(\`<div class="card-box fork-box">
        <div class="card-box-head"><span>Antigravity Agent Prompt</span><button type="button" class="btn" id="cancelActionBtn">Close</button></div>
        <textarea rows="7" readonly style="width:100%;font-family:var(--mono);font-size:11.5px;background:#07080b;border:1px solid var(--border);border-radius:8px;padding:8px;color:var(--text)">\${esc(state.fallbackPromptText)}</textarea>
      </div>\`);
    }

    // Fork / Dependencies card
    if (node.waiting.total > 0) {
      const settled = node.waiting.satisfied;
      const total = node.waiting.total;
      const rows = (d.dependencies || [])
        .map((dep) => {
          const child = byId.get(dep.id);
          if (!child) return '';
          return \`<div class="branch-item" data-jump="\${esc(child.id)}">
            <span class="branch-title">\${esc(child.title)}</span>
            <span class="status-pill \${esc(child.uiState)}">\${esc(statusLabel(child))}</span>
          </div>\`;
        })
        .join('');
      parts.push(\`<div class="card-box fork-box">
        <div class="card-box-head">
          <span>Fork · \${settled}/\${total} settled</span>
          <span class="status-pill \${settled === total ? 'done' : 'active'}">\${settled === total ? 'Settled' : 'In progress'}</span>
        </div>
        \${rows}
      </div>\`);
    }

    // Handback Summary & Artifacts
    if (d.summary || (d.artifacts && d.artifacts.length > 0)) {
      const artHtml = (d.artifacts || [])
        .map((a) => {
          const loaded = state.expandedArtifacts[a.id];
          return \`<div class="branch-item" data-artifact="\${esc(a.id)}" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <span class="branch-title">📄 \${esc(a.name)}</span>
              <span style="font-family:var(--mono);font-size:11px;color:var(--text-dim)">v\${a.plan_version}</span>
            </div>
            \${loaded ? \`<pre class="artifact-pre">\${esc(loaded)}</pre>\` : ''}
          </div>\`;
        })
        .join('');
      parts.push(\`<div class="card-box">
        <div class="card-box-head"><span>▸ Handback summary recorded</span></div>
        \${d.summary ? \`<div class="handback-summary">\${esc(d.summary)}</div>\` : ''}
        \${artHtml}
      </div>\`);
    }

    // Verification Plan & Evidence
    const stepsHtml = (d.plan?.steps || [])
      .map((s) => {
        const covStep = (d.coverage?.steps || []).find((cs) => cs.stepId === s.id);
        const outcome = covStep?.latestOutcome || 'pending';
        const pillCls = outcome === 'passed' ? 'done' : outcome === 'failed' || outcome === 'error' ? 'failed' : '';
        return \`<div class="branch-item" style="cursor:default">
          <span class="branch-title">\${esc(s.title)}</span>
          <span class="status-pill \${pillCls}">\${esc(outcome)}</span>
        </div>\`;
      })
      .join('');
    parts.push(\`<div class="card-box">
      <div class="card-box-head"><span>Verification Plan (v\${d.plan_version})</span><span>\${esc(d.coverage?.state || 'unverified')}</span></div>
      \${stepsHtml || '<div style="color:var(--text-dim)">No steps</div>'}
    </div>\`);

    const body = $('drawerBody');
    body.innerHTML = parts.join('');

    body.querySelectorAll('[data-jump]').forEach((el) => {
      el.addEventListener('click', () => openDetail(el.getAttribute('data-jump')));
    });
    body.querySelectorAll('[data-artifact]').forEach((el) => {
      el.addEventListener('click', async () => {
        const aid = el.getAttribute('data-artifact');
        if (state.expandedArtifacts[aid]) {
          delete state.expandedArtifacts[aid];
          renderDrawer();
          return;
        }
        try {
          const res = await api(\`/api/work/\${encodeURIComponent(d.id)}/artifacts/\${encodeURIComponent(aid)}\`);
          state.expandedArtifacts[aid] = res.data?.content ?? '(empty)';
          renderDrawer();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    $('drawerCopyPrompt')?.addEventListener('click', () => copyAgentPrompt(d.id));
    $('drawerForkToggle')?.addEventListener('click', () => {
      state.activeAction = state.activeAction === 'fork' ? null : 'fork';
      renderDrawer();
      $('forkLines')?.focus();
    });
    $('drawerAcceptBtn')?.addEventListener('click', () => {
      state.activeAction = state.activeAction === 'accept' ? null : 'accept';
      renderDrawer();
      $('confirmAcceptBtn')?.focus();
    });
    $('drawerRequeueBtn')?.addEventListener('click', () => {
      state.activeAction = state.activeAction === 'requeue' ? null : 'requeue';
      renderDrawer();
      $('requeueReason')?.focus();
    });
    $('drawerCancelBtn')?.addEventListener('click', () => {
      state.activeAction = state.activeAction === 'cancel' ? null : 'cancel';
      renderDrawer();
      $('cancelReason')?.focus();
    });
    $('cancelActionBtn')?.addEventListener('click', () => {
      state.activeAction = null;
      renderDrawer();
    });
    $('forkForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const lines = $('forkLines').value
        .split('\\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!lines.length) return;
      try {
        await api(\`/api/work/\${encodeURIComponent(d.id)}/fork\`, {
          method: 'POST',
          body: JSON.stringify({
            revision: d.revision,
            reason: $('forkReason').value.trim() || 'Forked from UI',
            branches: lines.map((title) => ({ title, description: '' })),
          }),
        });
        state.activeAction = null;
        showToast(\`Forked \${lines.length} branch\${lines.length === 1 ? '' : 'es'}\`);
        await refresh();
        await openDetail(d.id);
      } catch (err) {
        showToast(err.message);
      }
    });
    $('acceptForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const summary = $('acceptSummary').value.trim();
      if (!summary) return;
      try {
        await api(\`/api/work/\${encodeURIComponent(d.id)}/accept\`, {
          method: 'POST',
          body: JSON.stringify({ summary }),
        });
        state.activeAction = null;
        showToast('Work accepted — dependents updated');
        await refresh();
        await openDetail(d.id);
      } catch (err) {
        showToast(err.message);
      }
    });
    $('requeueForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const reason = $('requeueReason').value.trim();
      if (!reason) return;
      try {
        await api(\`/api/work/\${encodeURIComponent(d.id)}/requeue\`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        state.activeAction = null;
        showToast('Work requeued');
        await refresh();
        await openDetail(d.id);
      } catch (err) {
        showToast(err.message);
      }
    });
    $('cancelWorkForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const reason = $('cancelReason').value.trim();
      if (!reason) return;
      try {
        await api(\`/api/work/\${encodeURIComponent(d.id)}/cancel\`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        state.activeAction = null;
        showToast('Work cancelled');
        await refresh();
        await openDetail(d.id);
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  async function refresh() {
    const qs = new URLSearchParams();
    if (state.selectedRootId) qs.set('rootId', state.selectedRootId);
    if (state.selectedProjectId) qs.set('projectId', state.selectedProjectId);
    const res = await api(\`/api/graph?\${qs.toString()}\`);
    state.mode = res.mode;
    state.graph = res.data;
    state.projects = res.projects || [];

    const chip = $('modeChip');
    chip.classList.toggle('demo', state.mode === 'demo');
    $('modeText').textContent = state.mode === 'demo' ? 'Demo' : 'Live';
    $('demoBanner').classList.toggle('visible', state.mode === 'demo');

    renderSelectors();
    renderGraph();
    renderNext();
    renderTasks();
    if (state.selectedWorkId && $('drawer').classList.contains('open') && !state.activeAction) {
      const stillExists = state.graph.nodes.some((n) => n.id === state.selectedWorkId);
      if (stillExists) {
        try {
          const det = await api(\`/api/work/\${encodeURIComponent(state.selectedWorkId)}\`);
          state.selectedDetail = det.data;
          renderDrawer();
        } catch {}
      }
    }
  }

  // Tab switching
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.getAttribute('data-tab');
      document.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view-pane').forEach((p) => p.classList.remove('active'));
      $(\`pane-\${state.tab}\`).classList.add('active');
      $('viewTitle').textContent =
        state.tab === 'graph' ? 'Graph' : state.tab === 'next' ? 'Next' : 'Tasks';
      $('zoomControls').style.display = state.tab === 'graph' ? 'inline-flex' : 'none';
      if (state.tab === 'graph' && lastLayout) applyTransform();
    });
  });

  // Filters & Toolbar
  $('rootSelect').addEventListener('change', (e) => {
    state.selectedRootId = e.target.value;
    state.hasFittedOnce = false;
    refresh();
  });
  $('projectSelect').addEventListener('change', (e) => {
    state.selectedProjectId = e.target.value;
    state.selectedRootId = '';
    state.hasFittedOnce = false;
    refresh();
  });
  $('frontierOnlyBtn').addEventListener('click', () => {
    state.frontierOnly = !state.frontierOnly;
    $('frontierOnlyBtn').classList.toggle('active', state.frontierOnly);
    renderGraph();
  });
  $('pollToggle').addEventListener('click', () => {
    state.autoPoll = !state.autoPoll;
    $('pollToggle').classList.toggle('active', state.autoPoll);
    $('pollToggle').textContent = state.autoPoll ? 'Live' : 'Paused';
  });
  $('refreshBtn').addEventListener('click', () => refresh());
  $('retryLiveBtn').addEventListener('click', async () => {
    await api('/api/reconnect', { method: 'POST' });
    await refresh();
  });

  // Pan & Zoom on canvas
  const vp = $('viewport');
  let drag = null;
  vp.addEventListener('mousedown', (e) => {
    if (e.target.closest('.node-card')) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: state.transform.x, oy: state.transform.y };
    vp.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    state.transform.x = drag.ox + (e.clientX - drag.sx);
    state.transform.y = drag.oy + (e.clientY - drag.sy);
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    drag = null;
    vp.classList.remove('dragging');
  });
  vp.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const prev = state.transform.scale;
      const next = Math.max(0.25, Math.min(2.2, prev * factor));
      state.transform.x = mx - ((mx - state.transform.x) / prev) * next;
      state.transform.y = my - ((my - state.transform.y) / prev) * next;
      state.transform.scale = next;
      applyTransform();
    },
    { passive: false },
  );
  $('zoomInBtn').addEventListener('click', () => {
    state.transform.scale = Math.min(2.2, state.transform.scale * 1.18);
    applyTransform();
  });
  $('zoomOutBtn').addEventListener('click', () => {
    state.transform.scale = Math.max(0.25, state.transform.scale * 0.85);
    applyTransform();
  });
  $('fitBtn').addEventListener('click', () => fitToView(lastLayout));

  // Drawer close
  $('closeDrawerBtn').addEventListener('click', () => {
    $('drawer').classList.remove('open');
    state.selectedWorkId = null;
    renderGraph();
  });

  // Create modal
  function openCreateModal() {
    const depSel = $('newDep');
    depSel.innerHTML =
      '<option value="">None (new root)</option>' +
      (state.graph?.nodes || [])
        .map((n) => \`<option value="\${esc(n.id)}">\${esc(n.title)}</option>\`)
        .join('');
    $('createModal').classList.add('open');
    $('newTitle').focus();
  }
  $('createBtn').addEventListener('click', openCreateModal);
  $('emptyCreateBtn').addEventListener('click', openCreateModal);
  $('closeCreateModal').addEventListener('click', () => $('createModal').classList.remove('open'));
  $('cancelCreateModal').addEventListener('click', () => $('createModal').classList.remove('open'));
  $('createForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const depId = $('newDep').value;
    try {
      const res = await api('/api/work/create', {
        method: 'POST',
        body: JSON.stringify({
          title: $('newTitle').value.trim(),
          description: $('newDesc').value.trim(),
          projectId: state.selectedProjectId || undefined,
          dependencies: depId ? [{ id: depId, gate: 'done' }] : [],
          steps: [{ key: 'verify', title: $('newStep').value.trim(), required: true }],
        }),
      });
      $('createModal').classList.remove('open');
      $('createForm').reset();
      $('newStep').value = 'Verify result and record handback summary';
      showToast('Work item created');
      state.hasFittedOnce = false;
      await refresh();
      if (res.data?.id) await openDetail(res.data.id);
    } catch (err) {
      showToast(err.message);
    }
  });

  // Initial load + auto-poll
  refresh().catch((err) => showToast(err.message));
  setInterval(() => {
    if (state.autoPoll && !document.hidden) refresh().catch(() => {});
  }, 3000);
})();
</script>
</body>
</html>`;
}
