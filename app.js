/* ================================================================
   Agent Protocol Tech Tree — Application
   Static SPA: hash-based routing, YAML data, scroll animation
   ================================================================ */

// ── Global State ──────────────────────────────────────────────────
let DATA = null;
let currentView = null;   // 'tree' | 'detail'
let currentProtocolId = null;
let activeSceneIndex = 0;
let scrollObserver = null;
let fadeTimeout = null;
let scrollRafId = null;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const unlockedIds = new Set();

// ── Layout Configuration ─────────────────────────────────────────
const cfg = {
  boxW: 204,
  boxH: 80,
  gapX: 100,
  gapY: 30,
  marginX: 60,
  marginY: 60,
};

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  try {
    const resp = await fetch('data.yaml');
    if (!resp.ok) throw new Error('Failed to load data.yaml');
    const text = await resp.text();
    DATA = jsyaml.load(text);
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div class="loading">Error loading data: ${escapeHtml(err.message)}<br>
       <small>Serve via HTTP: python -m http.server</small></div>`;
    return;
  }
  createToolbar();
  window.addEventListener('hashchange', route);
  route();
}

// ── Toolbar (Edit + Fullscreen) ───────────────────────────────────
function createToolbar() {
  // Toolbar is now created inline in showTree/showDetail
  // Just set up fullscreen listeners once
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
  }
}

function getToolbarHtml() {
  let html = '<div class="toolbar" id="toolbar">';
  
  // Edit button (GitHub link)
  html += `<a class="toolbar-btn" href="https://github.com/jcushman/agent-protocols/" target="_blank" rel="noopener noreferrer" aria-label="Edit on GitHub">
    <span class="btn-icon">&lt;/&gt;</span> Edit
  </a>`;
  
  // Fullscreen button (only if supported)
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    html += `<button class="toolbar-btn" id="fullscreen-btn" aria-label="Toggle fullscreen">
      <span class="btn-icon">[ ]</span> Fullscreen
    </button>`;
  }
  
  html += '</div>';
  return html;
}

function attachToolbarListeners() {
  const fsBtn = document.getElementById('fullscreen-btn');
  if (fsBtn) {
    fsBtn.addEventListener('click', toggleFullscreen);
  }
}

// ── Fullscreen ────────────────────────────────────────────────────
function toggleFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    // Enter fullscreen
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    } else if (document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen();
    }
  } else {
    // Exit fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

function updateFullscreenButton() {
  const btn = document.getElementById('fullscreen-btn');
  if (!btn) return;
  
  const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFullscreen) {
    btn.innerHTML = '<span class="fs-icon">[x]</span> Exit';
  } else {
    btn.innerHTML = '<span class="fs-icon">[ ]</span> Fullscreen';
  }
}

// ── Router ────────────────────────────────────────────────────────
function route() {
  cleanup();
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash && DATA.technologies.find(t => t.id === hash)) {
    showDetail(hash);
  } else {
    showTree();
  }
}

function cleanup() {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  if (fadeTimeout) {
    clearTimeout(fadeTimeout);
    fadeTimeout = null;
  }
  if (scrollRafId) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
}

// ── Navigate ──────────────────────────────────────────────────────
function navigateTo(hash) {
  window.location.hash = hash ? `#${hash}` : '#';
}

// ── Layout Helpers ────────────────────────────────────────────────

function isLocked(tech) {
  return tech.unlock && tech.unlock.state === 'locked' && !unlockedIds.has(tech.id);
}

// Helper: get array of parent IDs (supports both parent and parents in layout)
function getLayoutParentIds(n) {
  if (n.layout.parents && n.layout.parents.length) return n.layout.parents;
  if (n.layout.parent) return [n.layout.parent];
  return [];
}

// Resolve column positions from parent + offset relationships
// Nodes specify layout: { parent: "parent-id", offset: 2 } where offset defaults to 1
// Root nodes (no parent) get column 0
function resolveColumns(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const resolved = new Map(); // id -> column
  
  function getCol(nodeId) {
    if (resolved.has(nodeId)) return resolved.get(nodeId);
    
    const node = byId.get(nodeId);
    if (!node) return 0;
    
    const parentIds = getLayoutParentIds(node);
    if (parentIds.length === 0) {
      // Root node
      resolved.set(nodeId, 0);
      return 0;
    }
    
    // Get the first parent's column (use first parent for column calculation)
    const parentCol = getCol(parentIds[0]);
    const offset = node.layout.offset !== undefined ? node.layout.offset : 1;
    const col = parentCol + offset;
    resolved.set(nodeId, col);
    return col;
  }
  
  // Resolve all nodes
  nodes.forEach(n => getCol(n.id));
  
  // Store resolved columns back on layout objects for use elsewhere
  nodes.forEach(n => {
    n.layout.col = resolved.get(n.id);
  });
  
  return resolved;
}

// Compute positions using column-based layout algorithm
// Algorithm:
//   1. Resolve columns from parent + offset relationships
//   2. Create placeholders for edges that skip columns
//   3. Compute "subtree height" for each node (right-to-left pass)
//   4. Position nodes left-to-right, spacing siblings by subtree height
//   5. Children stay centered on parents; parents spread to accommodate
//   6. Multi-parent nodes center on the centroid of all parents
function computePositions(nodes) {
  // First, resolve column positions from parent + offset
  resolveColumns(nodes);
  
  const byId = new Map(nodes.map((n, i) => [n.id, { ...n, inputIdx: i }]));
  
  // Step 1: Create placeholders for edges that span multiple columns
  // Key insight: create separate placeholders for each "cluster" of skip-col children
  // A new cluster starts when there's a real node between consecutive skip-col destinations
  
  const placeholders = [];
  const placeholderMap = new Map(); // "parentId-col-cluster" -> placeholder
  const nodeToPlaceholderCluster = new Map(); // "nodeId-parentId-col" -> cluster index
  
  // First, gather all skip-column edges grouped by (parent, intermediate col)
  const skipEdgeGroups = new Map();
  
  nodes.forEach((n, inputIdx) => {
    const parentIds = getLayoutParentIds(n);
    for (const pid of parentIds) {
      const parentNode = byId.get(pid);
      if (!parentNode || n.layout.col <= parentNode.layout.col + 1) continue;
      
      // This edge needs placeholders at each intermediate column
      for (let col = parentNode.layout.col + 1; col < n.layout.col; col++) {
        const groupKey = `${pid}-${col}`;
        if (!skipEdgeGroups.has(groupKey)) {
          skipEdgeGroups.set(groupKey, { parentId: pid, col, children: [] });
        }
        skipEdgeGroups.get(groupKey).children.push({ node: n, inputIdx });
      }
    }
  });
  
  // Also collect real nodes at each column for cluster detection
  const realNodesAtCol = new Map();
  nodes.forEach((n, inputIdx) => {
    if (!realNodesAtCol.has(n.layout.col)) realNodesAtCol.set(n.layout.col, []);
    realNodesAtCol.get(n.layout.col).push({ node: n, inputIdx });
  });
  
  // Now process each group to create clustered placeholders
  for (const [groupKey, group] of skipEdgeGroups) {
    const { parentId, col, children } = group;
    const realNodes = realNodesAtCol.get(col) || [];
    
    // Sort children by inputIdx
    children.sort((a, b) => a.inputIdx - b.inputIdx);
    
    // Sort real nodes by inputIdx  
    const sortedRealNodes = [...realNodes].sort((a, b) => a.inputIdx - b.inputIdx);
    
    // Assign cluster indices: increment cluster when a real node appears between consecutive children
    let clusterIdx = 0;
    let realNodePointer = 0;
    
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      
      // Check if any real node comes between this child and the previous one
      if (i > 0) {
        const prevChildIdx = children[i - 1].inputIdx;
        const currChildIdx = child.inputIdx;
        
        // Count real nodes between prev and curr
        while (realNodePointer < sortedRealNodes.length && 
               sortedRealNodes[realNodePointer].inputIdx < currChildIdx) {
          if (sortedRealNodes[realNodePointer].inputIdx > prevChildIdx) {
            // Found a real node between prev and curr - start new cluster
            clusterIdx++;
            break;
          }
          realNodePointer++;
        }
      }
      
      // Record which cluster this node belongs to for this parent-col combo
      nodeToPlaceholderCluster.set(`${child.node.id}-${parentId}-${col}`, clusterIdx);
      
      // Create placeholder for this cluster if it doesn't exist
      const phKey = `${parentId}-${col}-${clusterIdx}`;
      if (!placeholderMap.has(phKey)) {
        const prevCol = col - 1;
        const prevPhKey = `${parentId}-${prevCol}-${clusterIdx}`;
        const parentNode = byId.get(parentId);
        
        placeholders.push({
          id: `ph-${phKey}`,
          layout: { col: col },
          parent: col === parentNode.layout.col + 1 ? parentId : `ph-${prevPhKey}`,
          isPlaceholder: true,
          inputIdx: child.inputIdx, // Use first child's inputIdx for positioning
        });
        placeholderMap.set(phKey, placeholders[placeholders.length - 1]);
      }
    }
  }
  
  // Compute layoutParents: for each node, list of layout parent IDs
  // If node skips columns, use the cluster-specific placeholder in col-1 for that parent
  const layoutParents = new Map();
  nodes.forEach(n => {
    const parentIds = getLayoutParentIds(n);
    if (parentIds.length === 0) {
      layoutParents.set(n.id, []);
    } else {
      const lps = parentIds.map(pid => {
        const parentNode = byId.get(pid);
        if (parentNode && n.layout.col > parentNode.layout.col + 1) {
          // Look up the cluster index for this node-parent-col combo
          const clusterKey = `${n.id}-${pid}-${n.layout.col - 1}`;
          const clusterIdx = nodeToPlaceholderCluster.get(clusterKey) || 0;
          return `ph-${pid}-${n.layout.col - 1}-${clusterIdx}`;
        }
        return pid;
      });
      layoutParents.set(n.id, lps);
    }
  });
  
  const allItems = [
    ...nodes.map((n, i) => ({ ...n, inputIdx: i })),
    ...placeholders
  ];
  
  const columns = new Map();
  allItems.forEach(item => {
    const col = item.layout.col;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(item);
  });
  
  // Sort each column by inputIdx to preserve input order
  columns.forEach(items => items.sort((a, b) => a.inputIdx - b.inputIdx));
  
  const sortedCols = [...columns.keys()].sort((a, b) => a - b);
  const maxCol = Math.max(...sortedCols);
  
  // Step 2: Build children map (parent -> children)
  const childrenOf = new Map();
  allItems.forEach(item => {
    const lps = layoutParents.get(item.id) || (item.parent ? [item.parent] : []);
    for (const pid of lps) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(item);
    }
  });
  
  // Step 3: Compute subtree height for each node (right-to-left)
  // For multi-parent children, they are positioned separately (not in subtree calc)
  const subtreeHeight = new Map();
  
  for (let col = maxCol; col >= 0; col--) {
    const items = columns.get(col) || [];
    for (const item of items) {
      const children = childrenOf.get(item.id) || [];
      // Filter to children with this as their ONLY layout parent
      const singleParentChildren = children.filter(c => {
        const lps = layoutParents.get(c.id) || (c.parent ? [c.parent] : []);
        return lps.length === 1;
      });
      
      if (singleParentChildren.length === 0) {
        subtreeHeight.set(item.id, cfg.boxH);
      } else {
        const childHeights = singleParentChildren.map(c => subtreeHeight.get(c.id) || cfg.boxH);
        const totalHeight = childHeights.reduce((sum, h) => sum + h, 0) + (singleParentChildren.length - 1) * cfg.gapY;
        subtreeHeight.set(item.id, totalHeight);
      }
    }
  }
  
  // Step 4: Position nodes left-to-right
  const relY = new Map();
  
  for (const col of sortedCols) {
    const items = columns.get(col);
    
    // Separate items: single-parent (grouped by parent) vs multi-parent (own position)
    const singleParentItems = [];
    const multiParentItems = [];
    
    items.forEach(item => {
      const lps = layoutParents.get(item.id) || (item.parent ? [item.parent] : []);
      if (lps.length <= 1) {
        singleParentItems.push(item);
      } else {
        multiParentItems.push(item);
      }
    });
    
    // Group single-parent items by their parent
    const byParent = new Map();
    singleParentItems.forEach(item => {
      const lps = layoutParents.get(item.id) || (item.parent ? [item.parent] : []);
      const pid = lps[0] || "__root__";
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(item);
    });
    
    // Position single-parent groups centered around their parent
    for (const [pid, group] of byParent) {
      const parentCenterY = (pid !== "__root__" && relY.has(pid)) ? relY.get(pid) : 0;
      
      const heights = group.map(item => subtreeHeight.get(item.id) || cfg.boxH);
      const totalSpan = heights.reduce((sum, h) => sum + h, 0) + (group.length - 1) * cfg.gapY;
      
      let currentY = parentCenterY - totalSpan / 2;
      group.forEach((item, i) => {
        const h = heights[i];
        relY.set(item.id, currentY + h / 2);
        currentY += h + cfg.gapY;
      });
    }
    
    // Position multi-parent items centered on centroid of all parents
    multiParentItems.forEach(item => {
      const lps = layoutParents.get(item.id) || [];
      const parentYs = lps.map(pid => relY.get(pid)).filter(y => y !== undefined);
      if (parentYs.length > 0) {
        const centroidY = parentYs.reduce((sum, y) => sum + y, 0) / parentYs.length;
        relY.set(item.id, centroidY);
      } else {
        relY.set(item.id, 0);
      }
    });
    
    // Collision resolution: sort ALL items by inputIdx
    const allColItems = [...items].sort((a, b) => a.inputIdx - b.inputIdx);
    
    // Push items down if they overlap with previous
    for (let i = 1; i < allColItems.length; i++) {
      const prev = allColItems[i - 1];
      const curr = allColItems[i];
      
      const prevBottom = relY.get(prev.id) + (subtreeHeight.get(prev.id) || cfg.boxH) / 2;
      const currTop = relY.get(curr.id) - (subtreeHeight.get(curr.id) || cfg.boxH) / 2;
      const overlap = prevBottom + cfg.gapY - currTop;
      
      if (overlap > 0) {
        for (let j = i; j < allColItems.length; j++) {
          relY.set(allColItems[j].id, relY.get(allColItems[j].id) + overlap);
        }
      }
    }
  }
  
  // Step 5: Convert relative positions to absolute canvas positions
  let minRelY = Infinity;
  relY.forEach(y => { minRelY = Math.min(minRelY, y); });
  
  const offsetY = cfg.marginY + cfg.boxH / 2 - minRelY;
  
  const pos = new Map();
  allItems.forEach(item => {
    const centerY = relY.get(item.id);
    const x = cfg.marginX + item.layout.col * (cfg.boxW + cfg.gapX);
    const y = centerY + offsetY - cfg.boxH / 2;
    pos.set(item.id, {
      x, y,
      col: item.layout.col,
      isPlaceholder: item.isPlaceholder,
      centerY: centerY + offsetY
    });
  });
  
  return { pos, nodeToPlaceholderCluster };
}

// Edge routing helpers
function midRight(p) { return { x: p.x + cfg.boxW, y: p.centerY }; }
function midLeft(p)  { return { x: p.x, y: p.centerY }; }

function betweenColsX(colA, colB) {
  const xRightA = cfg.marginX + colA * (cfg.boxW + cfg.gapX) + cfg.boxW;
  const xLeftB  = cfg.marginX + colB * (cfg.boxW + cfg.gapX);
  return (xRightA + xLeftB) / 2;
}

function routeEdge(parentNode, childNode, pos, nodeToPlaceholderCluster) {
  const p = pos.get(parentNode.id);
  const c = pos.get(childNode.id);
  const S = midRight(p);
  const E = midLeft(c);
  
  const pts = [S];
  
  // Collect waypoints: placeholders in intermediate columns (cluster-specific)
  const waypoints = [];
  for (let col = p.col + 1; col < c.col; col++) {
    // Look up the cluster index for this specific edge
    const clusterKey = `${childNode.id}-${parentNode.id}-${col}`;
    const clusterIdx = nodeToPlaceholderCluster.get(clusterKey) || 0;
    const phId = `ph-${parentNode.id}-${col}-${clusterIdx}`;
    if (pos.has(phId)) {
      waypoints.push(pos.get(phId));
    }
  }
  
  if (waypoints.length === 0) {
    // Direct connection
    const xHop = betweenColsX(p.col, c.col);
    pts.push({ x: xHop, y: S.y });
    pts.push({ x: xHop, y: E.y });
  } else {
    // Route through placeholders
    let prevY = S.y;
    
    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const xHop = betweenColsX(wp.col - 1, wp.col);
      pts.push({ x: xHop, y: prevY });
      pts.push({ x: xHop, y: wp.centerY });
      prevY = wp.centerY;
    }
    
    const lastWp = waypoints[waypoints.length - 1];
    const xHop = betweenColsX(lastWp.col, c.col);
    pts.push({ x: xHop, y: prevY });
    pts.push({ x: xHop, y: E.y });
  }
  
  pts.push(E);
  return pts;
}

function polylinePath(points) {
  return points.map((pt, i) => (i === 0 ? `M ${pt.x},${pt.y}` : `L ${pt.x},${pt.y}`)).join(" ");
}

// ================================================================
//  TREE VIEW
// ================================================================

function showTree() {
  currentView = 'tree';
  currentProtocolId = null;
  document.title = DATA.title;

  const techs = DATA.technologies;
  const byId = new Map(techs.map(t => [t.id, t]));
  const { pos, nodeToPlaceholderCluster } = computePositions(techs);

  // DEBUG: Log layout info
  console.group('Tree Layout Debug');
  console.log('Technologies:', techs.map(t => ({
    id: t.id,
    col: t.layout.col,
    parent: t.layout.parent,
    parents: t.layout.parents,
  })));
  console.log('Positions:', [...pos.entries()].map(([id, p]) => ({
    id,
    col: p.col,
    x: p.x,
    y: p.y,
    isPlaceholder: p.isPlaceholder,
  })));
  console.groupEnd();

  // Calculate wrapper dimensions from positions
  let maxX = 0, maxY = 0;
  pos.forEach(p => {
    if (p.isPlaceholder) return;
    maxX = Math.max(maxX, p.x + cfg.boxW);
    maxY = Math.max(maxY, p.y + cfg.boxH);
  });
  const wrapperW = maxX + cfg.marginX;
  const wrapperH = maxY + cfg.marginY;

  // Build node HTML (absolutely positioned)
  let nodesHtml = '';
  techs.forEach(tech => {
    const p = pos.get(tech.id);
    const locked = isLocked(tech);
    const lockedClass = locked ? ' node-locked' : '';

    const iconHtml = tech.icon
      ? `<img src="${escapeHtml(tech.icon)}" alt="${escapeHtml(tech.icon_alt)}" class="node-icon-img">`
      : escapeHtml(tech.icon_alt);

    nodesHtml += `
      <div class="tree-node${lockedClass}" tabindex="0" role="button"
           data-id="${tech.id}"
           aria-label="${escapeHtml(tech.title)}: ${escapeHtml(tech.tagline)}"
           style="left:${p.x}px;top:${p.y}px;width:${cfg.boxW}px;height:${cfg.boxH}px;">
        <div class="node-header">
          <div class="node-icon" aria-hidden="true">${iconHtml}</div>
          <div class="node-title">${escapeHtml(tech.title)}</div>
        </div>
        <div class="node-tagline">${escapeHtml(tech.tagline)}</div>
      </div>`;
  });

  // Build SVG connections using edge routing (supports multiple parents)
  let svgPaths = '';
  svgPaths += `<defs>
    <marker id="ah" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
      <polygon points="0 0, 10 4, 0 8" class="arrow-head"/>
    </marker>
  </defs>`;

  // DEBUG: Log edges being drawn
  console.group('Edges Debug');
  techs.forEach(tech => {
    const parentIds = getLayoutParentIds(tech);
    for (const pid of parentIds) {
      const parentNode = byId.get(pid);
      if (!parentNode) continue;
      
      const pts = routeEdge(parentNode, tech, pos, nodeToPlaceholderCluster);
      console.log(`Edge: ${pid} → ${tech.id}`, { 
        parentCol: parentNode.layout.col, 
        childCol: tech.layout.col,
        points: pts 
      });
      svgPaths += `<path d="${polylinePath(pts)}" marker-end="url(#ah)"/>`;
    }
  });
  console.groupEnd();

  // Build cluster outlines (computed from member bounding boxes)
  let clustersHtml = '';
  (DATA.clusters || []).forEach(cluster => {
    const members = techs.filter(t => cluster.members.includes(t.id));
    if (!members.length) return;
    const clPad = 14;
    const memberPos = members.map(m => pos.get(m.id));
    const cMinX = Math.min(...memberPos.map(p => p.x));
    const cMaxX = Math.max(...memberPos.map(p => p.x));
    const cMinY = Math.min(...memberPos.map(p => p.y));
    const cMaxY = Math.max(...memberPos.map(p => p.y));
    const cx = cMinX - clPad;
    const cy = cMinY - clPad;
    const cw = (cMaxX - cMinX) + cfg.boxW + clPad * 2;
    const ch = (cMaxY - cMinY) + cfg.boxH + clPad * 2;
    clustersHtml += `
      <div class="tree-group" style="left:${cx}px;top:${cy}px;width:${cw}px;height:${ch}px">
        <span class="tree-group-label">${escapeHtml(cluster.label)}</span>
      </div>`;
  });

  const readMoreBtn = DATA.details ? `<button class="read-more-btn" onclick="showDetailsModal()">Read more &gt;</button>` : '';

  document.getElementById('app').innerHTML = `
    <div class="tree-page">
      <header class="tree-header">
        <div class="tree-header-text">
          <h1>${escapeHtml(DATA.title)}</h1>
          <p>${escapeHtml(DATA.subtitle)}</p>
          ${readMoreBtn}
        </div>
        ${getToolbarHtml()}
      </header>
      <div class="tree-container">
        <div class="tree-wrapper" style="width:${wrapperW}px;height:${wrapperH}px">
          <svg class="tree-svg" width="${wrapperW}" height="${wrapperH}" viewBox="0 0 ${wrapperW} ${wrapperH}">
            ${svgPaths}
          </svg>
          ${clustersHtml}
          ${nodesHtml}
        </div>
      </div>
      <footer class="tree-footer">Click a node to explore how it works</footer>
    </div>`;

  attachToolbarListeners();

  // Center the scroll on the tree
  const treeContainer = document.querySelector('.tree-container');
  if (treeContainer) {
    const wrapper = document.querySelector('.tree-wrapper');
    if (wrapper) {
      const centerX = wrapperW / 2;
      const targetScroll = centerX - treeContainer.clientWidth / 2;
      treeContainer.scrollLeft = Math.max(0, targetScroll);
    }
  }

  // Attach click handlers (unlock on first click, navigate on second)
  document.querySelectorAll('.tree-node').forEach(node => {
    function handleClick() {
      const id = node.dataset.id;
      const tech = techs.find(t => t.id === id);
      if (tech && isLocked(tech)) {
        // Unlock the node
        unlockedIds.add(id);
        node.classList.remove('node-locked');
        node.classList.add('node-unlocking');
        const overlay = node.querySelector('.unlock-overlay');
        if (overlay) {
          overlay.classList.add('unlock-fade');
          overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
        }
      } else {
        navigateTo(id);
      }
    }
    node.addEventListener('click', handleClick);
    node.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    });
  });
}

// ================================================================
//  DETAIL VIEW
// ================================================================

function showDetail(techId) {
  currentView = 'detail';
  currentProtocolId = techId;
  activeSceneIndex = 0;

  const tech = DATA.technologies.find(t => t.id === techId);
  if (!tech) { navigateTo(''); return; }

  // Auto-unlock if navigated directly via URL hash
  if (tech.unlock && tech.unlock.state === 'locked') {
    unlockedIds.add(techId);
  }

  document.title = `${tech.title} — ${DATA.title}`;

  const detail = tech.detail;
  const hasAnimation = tech.animation && tech.animation.scenes && tech.animation.scenes.length > 0;

  // Links bar
  let linksHtml = '';
  if (detail.links && detail.links.length) {
    linksHtml = `<div class="detail-links">${detail.links.map(link =>
      `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="detail-link">${escapeHtml(link.label)}</a>`
    ).join('')}</div>`;
  }

  // How it works (scrollytelling animation) — skip if no animation
  let animHtml = '';
  if (hasAnimation) {
    const scenes = tech.animation.scenes;
    const stepsHtml = scenes.map((scene, i) => `
      <div class="step${i === 0 ? ' active' : ''}" data-scene="${i}">
        <div class="step__content">
          <div class="step__number">Step ${i + 1} of ${scenes.length}</div>
          <div class="step__title">${escapeHtml(scene.title)}</div>
          <div class="step__description">${escapeHtml(scene.description)}</div>
        </div>
      </div>
    `).join('');

    animHtml = `
      <div class="how-it-works detail-section">
        <div class="section-label">How it works</div>
        <div class="scrolly" id="scrolly">
          <div class="scrolly__graphic" id="anim-stage">
            <div class="anim-stage" id="anim-root"></div>
          </div>
          <div class="scrolly__steps" id="scrolly-steps">
            ${stepsHtml}
          </div>
        </div>
      </div>`;
  }

  // Virtuous cycle (array → <ul>)
  let cycleHtml = '';
  if (detail.virtuous_cycle && detail.virtuous_cycle.length) {
    cycleHtml = `
      <div class="detail-section">
        <div class="section-label">The virtuous cycle</div>
        <ul class="virtuous-cycle">
          ${detail.virtuous_cycle.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>`;
  }

  // Icon for hero (larger)
  const heroIconHtml = tech.icon
    ? `<img src="${escapeHtml(tech.icon)}" alt="${escapeHtml(tech.icon_alt)}" class="hero-icon-img">`
    : escapeHtml(tech.icon_alt);

  // Reduced-motion check
  const isReduced = prefersReducedMotion.matches;

  document.getElementById('app').innerHTML = `
    <div class="detail-page">
      <header class="detail-header">
        <button class="back-btn" onclick="navigateTo('')">&larr; Tree</button>
        ${getToolbarHtml()}
      </header>
      <div class="detail-content">
        <div class="detail-hero">
          <div class="hero-icon" aria-hidden="true">${heroIconHtml}</div>
          <div class="hero-text">
            <h1 class="hero-title">${escapeHtml(tech.title)}</h1>
            <div class="tagline">${escapeHtml(tech.tagline)}</div>
          </div>
        </div>

        ${linksHtml}

        <div class="detail-section">
          <div class="section-label">What it solves</div>
          <div class="section-body">${escapeHtml(detail.what_it_solves)}</div>
        </div>

        ${animHtml}

        <div class="detail-section">
          <div class="section-label">How it&rsquo;s standardizing</div>
          <div class="section-body">${escapeHtml(detail.how_its_standardizing)}</div>
        </div>

        ${cycleHtml}
      </div>
    </div>`;

  // Initialize animation if present
  if (hasAnimation) {
    initAnimation(tech);

    if (!isReduced && window.innerWidth > 768) {
      setupScrollObserver(tech);
    } else {
      // Stacked mode: clicking steps switches scenes
      document.querySelectorAll('.step').forEach(step => {
        step.addEventListener('click', () => {
          const idx = parseInt(step.dataset.scene, 10);
          transitionToScene(tech, idx);
          document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
          step.classList.add('active');
        });
      });
    }
  }

  // Attach toolbar listeners
  attachToolbarListeners();

  // Scroll to top
  window.scrollTo(0, 0);
}

// ================================================================
//  ANIMATION ENGINE
// ================================================================

function initAnimation(tech) {
  const root = document.getElementById('anim-root');
  if (!root || !tech.animation) return;

  // Reset previous visible actors for sparkle comparison
  previousVisibleIds = [];

  const allActors = tech.animation.actors;

  // Create persistent actor elements
  let actorsHtml = '<div class="anim-actors" id="anim-actors">';
  allActors.forEach(actor => {
    const iconSrc = DATA.actor_icons && DATA.actor_icons[actor.type];
    const iconContent = iconSrc
      ? `<img src="${escapeHtml(iconSrc)}" alt="${escapeHtml(actorIconText(actor.type))}" class="actor-icon-img">`
      : escapeHtml(actorIconText(actor.type));
    actorsHtml += `
      <div class="anim-actor" id="actor-${actor.id}" data-id="${actor.id}" style="opacity:0;">
        <div class="actor-icon">${iconContent}</div>
        <div class="actor-label">${escapeHtml(actor.label)}</div>
      </div>`;
  });
  actorsHtml += '</div>';

  actorsHtml += '<div class="anim-messages" id="anim-messages"></div>';

  root.innerHTML = actorsHtml;

  // Show first scene
  setActiveScene(tech, 0);
}

let previousVisibleIds = [];

function setActiveScene(tech, index) {
  activeSceneIndex = index;
  const scene = tech.animation.scenes[index];
  if (!scene) return;

  const allActors = tech.animation.actors;
  const visibleIds = scene.actors_visible;
  const n = visibleIds.length;

  // Determine which actors are newly visible (not in previous scene)
  const newActorIds = scene.sparkle 
    ? visibleIds.filter(id => !previousVisibleIds.includes(id))
    : [];

  // Position and show/hide actors
  allActors.forEach(actor => {
    const el = document.getElementById(`actor-${actor.id}`);
    if (!el) return;
    const visibleIdx = visibleIds.indexOf(actor.id);
    if (visibleIdx >= 0) {
      const leftPct = ((visibleIdx + 0.5) / n) * 100;
      el.style.left = leftPct + '%';
      el.style.opacity = '1';
      // Add sparkle to newly visible actors
      el.classList.toggle('actor-sparkle', newActorIds.includes(actor.id));
    } else {
      el.style.opacity = '0';
      el.classList.remove('actor-sparkle');
    }
  });

  // Render messages
  renderMessages(scene, visibleIds, n);

  // Remember current visible actors for next scene comparison
  previousVisibleIds = [...visibleIds];
}

function renderMessages(scene, visibleIds, numActors) {
  const container = document.getElementById('anim-messages');
  if (!container) return;

  let html = '';
  scene.messages.forEach((msg, mi) => {
    const fromIdx = visibleIds.indexOf(msg.from);
    const toIdx = visibleIds.indexOf(msg.to);
    if (fromIdx < 0 || toIdx < 0) return;

    const fromPct = ((fromIdx + 0.5) / numActors) * 100;
    const toPct = ((toIdx + 0.5) / numActors) * 100;
    const leftPct = Math.min(fromPct, toPct);
    const widthPct = Math.abs(toPct - fromPct);
    const direction = toPct > fromPct ? 'right' : 'left';

    // Use json_full if available, otherwise fall back to json_preview for modal content
    const hasPreview = msg.json_preview && msg.json_preview.trim();
    const detailContent = (msg.json_full && msg.json_full.trim()) || msg.json_preview || '';
    const detailId = `msg-detail-${activeSceneIndex}-${mi}`;

    html += `
      <div class="anim-message">
        <div class="msg-label" style="margin-left:${leftPct}%;width:${widthPct}%">
          ${escapeHtml(msg.label)}
        </div>
        <div class="msg-arrow" style="margin-left:${leftPct}%;width:${widthPct}%">
          <div class="msg-arrow-head ${direction}"></div>
        </div>
        ${hasPreview ? `
          <div class="msg-preview expandable" style="margin-left:${Math.max(0, leftPct - 5)}%;width:${Math.min(100, widthPct + 10)}%"
               onclick="toggleDetail('${detailId}', '${escapeHtml(msg.label).replace(/'/g, "\\'")}'); event.stopPropagation();" onkeydown="if(event.key==='Enter'){toggleDetail('${detailId}', '${escapeHtml(msg.label).replace(/'/g, "\\'")}'); event.stopPropagation();}" role="button" tabindex="0" title="Click to expand">
            <code>${escapeHtml(msg.json_preview)}</code> <span class="expand-hint">[+]</span>
          </div>
          <div class="msg-detail" id="${detailId}" style="display:none;">${escapeHtml(detailContent.trim())}</div>` : ''}
      </div>`;
  });

  container.innerHTML = html;
}

// ── Scroll-based Scene Switching ──────────────────────────────────

function transitionToScene(tech, index) {
  if (index === activeSceneIndex) return;

  const root = document.getElementById('anim-root');
  if (!root) { setActiveScene(tech, index); return; }

  // Cancel any pending transition and remove leftover overlay
  if (fadeTimeout) clearTimeout(fadeTimeout);
  const oldOverlay = document.getElementById('anim-crossfade');
  if (oldOverlay) oldOverlay.remove();

  // Update index immediately so scroll handler doesn't retrigger
  activeSceneIndex = index;

  // Clone current content as a crossfade overlay
  const overlay = root.cloneNode(true);
  overlay.id = 'anim-crossfade';
  overlay.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.transition = 'opacity 0.5s ease';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '10';
  overlay.style.background = 'var(--bg)';
  root.appendChild(overlay);

  // Disable actor transitions so new positions appear instantly (hidden under overlay)
  root.querySelectorAll('.anim-actor').forEach(a => { a.style.transition = 'none'; });

  // Update the real content underneath the overlay
  setActiveScene(tech, index);

  // Restore actor transitions then fade out overlay to reveal new scene
  requestAnimationFrame(() => {
    root.querySelectorAll('.anim-actor').forEach(a => { a.style.transition = ''; });
    overlay.style.opacity = '0';
  });

  // Remove overlay after fade completes
  fadeTimeout = setTimeout(() => {
    overlay.remove();
    fadeTimeout = null;
  }, 550);
}

function setupScrollObserver(tech) {
  const graphic = document.querySelector('.scrolly__graphic');
  const steps = document.querySelectorAll('.step');
  if (!graphic || !steps.length) return;

  function checkScroll() {
    scrollRafId = null;
    const graphicBottom = graphic.getBoundingClientRect().bottom;

    // Active step = last step whose top edge is above the graphic's bottom edge
    let newIdx = 0;
    steps.forEach((step, i) => {
      if (step.getBoundingClientRect().top < graphicBottom) {
        newIdx = i;
      }
    });

    if (newIdx !== activeSceneIndex) {
      transitionToScene(tech, newIdx);
      steps.forEach(s => s.classList.remove('active'));
      steps[newIdx].classList.add('active');
    }
  }

  function onScroll() {
    if (!scrollRafId) {
      scrollRafId = requestAnimationFrame(checkScroll);
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  checkScroll(); // initial check

  // Compatible with cleanup() which calls .disconnect()
  scrollObserver = {
    disconnect: () => {
      window.removeEventListener('scroll', onScroll);
      if (scrollRafId) { cancelAnimationFrame(scrollRafId); scrollRafId = null; }
    }
  };
}

// ── Modal for JSON Detail ─────────────────────────────────────────
function showModal(content, title) {
  // Remove existing modal if any
  closeModal();
  
  const modal = document.createElement('div');
  modal.className = 'json-modal';
  modal.id = 'json-modal';
  modal.innerHTML = `
    <div class="json-modal__backdrop" onclick="closeModal()"></div>
    <div class="json-modal__content">
      <div class="json-modal__header">
        <div class="json-modal__title">${escapeHtml(title || 'Full Message')}</div>
        <button class="json-modal__close" onclick="closeModal()" aria-label="Close">&times;</button>
      </div>
      <pre class="json-modal__code">${escapeHtml(content)}</pre>
    </div>
  `;
  document.body.appendChild(modal);
  
  // Focus trap and escape key
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  modal.querySelector('.json-modal__close').focus();
}

function closeModal() {
  const modal = document.getElementById('json-modal');
  if (modal) modal.remove();
}

// ── Details Modal (Read more) ─────────────────────────────────────
function showDetailsModal() {
  if (!DATA || !DATA.details) return;
  
  closeModal();
  
  const modal = document.createElement('div');
  modal.className = 'json-modal';
  modal.id = 'json-modal';
  modal.innerHTML = `
    <div class="json-modal__backdrop" onclick="closeModal()"></div>
    <div class="json-modal__content">
      <div class="json-modal__header">
        <div class="json-modal__title">About This Project</div>
        <button class="json-modal__close" onclick="closeModal()" aria-label="Close">&times;</button>
      </div>
      <div class="json-modal__body">${DATA.details.trim()}</div>
    </div>
  `;
  document.body.appendChild(modal);
  
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  modal.querySelector('.json-modal__close').focus();
}

// ── Toggle JSON Detail (legacy inline, now opens modal) ───────────
function toggleDetail(id, label) {
  const el = document.getElementById(id);
  if (!el) return;
  const content = el.textContent || el.innerText;
  showModal(content, label);
}

// ── Actor Icon Text (fallback when no image) ──────────────────────
function actorIconText(type) {
  const icons = {
    app: 'APP',
    model: 'LLM',
    server: 'SRV',
    agent: 'AGT',
    file: 'DOC',
    repo: 'REPO',
    website: 'WEB',
    registry: 'REG',
    merchant: 'SHOP',
    skill: 'SKILL',
  };
  return icons[type] || type.toUpperCase().slice(0, 4);
}

// ── Escape HTML ───────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Boot ──────────────────────────────────────────────────────────
init();
