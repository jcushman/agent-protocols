/* ================================================================
   Agent Protocol Tech Tree — Application
   Static SPA: hash-based routing, YAML data
   ================================================================ */

// ── Global State ──────────────────────────────────────────────────
let DATA = null;
let currentView = null;   // 'tree' | 'detail' | 'reader'
let currentProtocolId = null;
let scrollObserver = null;
let modalReturnFocusEl = null;
const unlockedIds = new Set();
const BADGE_DEFS = {
  speculative: {
    label: 'speculative',
    iconHtml: '&#128640;',
  },
  unclear_adoption: {
    label: 'unclear adoption',
    iconHtml: '&asymp;',
  },
};

// ── Layout Configuration ─────────────────────────────────────────
const cfg = {
  boxW: 204,
  boxH: 80,
  gapX: 100,
  gapY: 30,
  marginX: 60,
  marginY: 60,
  clusterPad: 14,
};

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  try {
    const resp = await fetch('data.yaml');
    if (!resp.ok) throw new Error('Failed to load data.yaml');
    const text = await resp.text();
    DATA = jsyaml.load(text);
    buildLayoutFromTree();
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
  
  // GitHub link
  html += `<a class="toolbar-link" href="https://github.com/jcushman/agent-protocols/" target="_blank" rel="noopener noreferrer">Github</a>`;
  
  // Reader mode link
  html += `<span class="toolbar-sep">|</span>`;
  html += `<a class="toolbar-link" href="#reader">Reader</a>`;
  
  // Fullscreen button (only if supported)
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    html += `<span class="toolbar-sep">|</span>`;
    html += `<button type="button" class="toolbar-link" id="fullscreen-btn">Fullscreen</button>`;
  }
  
  html += '</div>';
  return html;
}

function getAttributionHtml() {
  return `<div class="attribution">
    <a href="https://lil.law.harvard.edu/" target="_blank" rel="noopener noreferrer" class="attribution-logo" aria-label="Library Innovation Lab">
      <svg role="img" width="40" height="56" viewBox="0 0 40 57" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <title>Library Innovation Lab</title>
        <path d="M0 8.09524H32V56.6667L40 48.5714V0H8L0 8.09524Z" fill="currentColor"></path>
        <path d="M16 16.1905H8V48.5714H24V40.4762H16V16.1905Z" fill="currentColor"></path>
      </svg>
    </a>
    <div class="attribution-text">
      <div class="attribution-line">A project of the <a href="https://lil.law.harvard.edu/" target="_blank" rel="noopener noreferrer">Library Innovation Lab</a></div>
      <div class="attribution-line"><a href="mailto:lil@law.harvard.edu">lil@law.harvard.edu</a></div>
    </div>
  </div>`;
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
  if (hash === 'reader' || hash.startsWith('reader-')) {
    // Only re-render reader if not already on the reader page
    if (currentView !== 'reader') {
      showReader();
    } else {
      // Re-attach scroll spy that was disconnected by cleanup()
      setupReaderScrollSpy();
      // Scroll to anchor if present, or top if plain #reader
      if (hash.startsWith('reader-')) {
        readerScrollTo(hash, { updateHash: false });
      } else {
        window.scrollTo(0, 0);
      }
    }
  } else if (hash && DATA.technologies.find(t => t.id === hash && !t._clusterNode)) {
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
}

// ── Navigate ──────────────────────────────────────────────────────
function navigateTo(hash) {
  window.location.hash = hash ? `#${hash}` : '#';
}

function focusElement(el) {
  if (!el || typeof el.focus !== 'function') return;
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
  }
  el.focus({ preventScroll: true });
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── Tree → Layout ────────────────────────────────────────────────
// Build layout properties from the `tree:` key in data.yaml.
// Walks the tree depth-first, setting layout.parent/parents and layout.col
// on each technology, and reorders DATA.technologies to match tree order
// (which controls vertical positioning within each column).

function buildLayoutFromTree() {
  const tree = DATA.tree;
  if (!tree) return;

  const techById = new Map(DATA.technologies.map(t => [t.id, t]));
  const orderedIds = [];
  const colById = new Map(); // id -> resolved column

  // Cluster metadata extracted from tree, replaces DATA.clusters
  DATA.clusters = [];

  function walk(nodes, structuralParentId, structuralParentCol) {
    for (const treeNode of nodes) {
      // ── Cluster node ──
      if (treeNode.cluster) {
        const extraCols = treeNode.extra_cols || 0;
        let col;
        if (structuralParentId !== null) {
          const parentCol = colById.has(structuralParentId)
            ? colById.get(structuralParentId)
            : structuralParentCol;
          col = parentCol + 1 + extraCols;
        } else {
          col = extraCols;
        }
        colById.set(treeNode.id, col);

        // ── display: node — render cluster as a single round-rect box ──
        if (treeNode.display === 'node') {
          // Create a synthetic technology for the cluster node
          const parents = [];
          if (structuralParentId !== null) parents.push(structuralParentId);

          const synthTech = {
            id: treeNode.id,
            title: treeNode.label,
            tagline: '',
            icon_alt: treeNode.icon_alt || treeNode.label.substring(0, 4),
            layout: { col },
            _clusterNode: true,
            _clusterDescription: treeNode.description || '',
            _clusterLabel: treeNode.label,
          };

          if (parents.length === 1) synthTech.layout.parent = parents[0];
          else if (parents.length > 1) synthTech.layout.parents = parents;

          DATA.technologies.push(synthTech);
          techById.set(treeNode.id, synthTech);
          orderedIds.push(treeNode.id);

          // Walk items + cluster children as regular children of this node
          const allChildren = [
            ...(treeNode.items || []),
            ...(treeNode.children || []),
          ];
          if (allChildren.length) {
            walk(allChildren, treeNode.id, col);
          }
          continue;
        }

        // ── Default cluster: dashed-outline group box ──
        const clusterItems = treeNode.items || [];
        const techItems = clusterItems.filter(it => !it.cluster);
        const nestedClusterItems = clusterItems.filter(it => it.cluster);
        const itemIds = techItems.map(it => it.id);
        const parentIds = structuralParentId !== null ? [structuralParentId] : [];
        if (itemIds.length > 0) {
          DATA.clusters.push({
            id: treeNode.id,
            label: treeNode.label,
            description: treeNode.description || '',
            col,
            members: itemIds,
            parentIds,
          });
        } else {
          console.warn(`Cluster has no direct technology items: ${treeNode.id}`);
        }

        // Walk items: each gets the cluster's column, no tree parent
        for (const item of techItems) {
          const tech = techById.get(item.id);
          if (!tech) {
            console.warn(`Cluster item references unknown technology: ${item.id}`);
            continue;
          }
          tech.layout = { col, _clusterId: treeNode.id };
          colById.set(item.id, col);
          orderedIds.push(item.id);

          // Items within a cluster can have their own children
          if (item.children) {
            walk(item.children, item.id, col);
          }
        }

        // Walk nested cluster-items as children of this cluster
        if (nestedClusterItems.length) {
          walk(nestedClusterItems, treeNode.id, col);
        }

        // Walk cluster-level children (e.g., inference-api from c-foundations)
        if (treeNode.children) {
          walk(treeNode.children, treeNode.id, col);
        }
        continue;
      }

      // ── Regular node ──
      const tech = techById.get(treeNode.id);
      if (!tech) {
        console.warn(`Tree references unknown technology: ${treeNode.id}`);
        continue;
      }

      // Build parent list: structural parent (from nesting) + extra_parents
      const parents = [];
      if (structuralParentId !== null) parents.push(structuralParentId);
      if (treeNode.extra_parents) parents.push(...treeNode.extra_parents);

      // Column formula: first_parent_col + 1 + extra_cols.
      // Roots with no parents at all get column 0.
      const extraCols = treeNode.extra_cols || 0;
      let col;
      if (parents.length > 0) {
        const firstParentCol = colById.has(parents[0])
          ? colById.get(parents[0])
          : (structuralParentId !== null ? structuralParentCol : 0);
        col = firstParentCol + 1 + extraCols;
      } else {
        col = extraCols;
      }
      colById.set(treeNode.id, col);

      tech.layout = { col };
      if (parents.length === 1) {
        tech.layout.parent = parents[0];
      } else if (parents.length > 1) {
        tech.layout.parents = parents;
      }

      orderedIds.push(treeNode.id);

      if (treeNode.children) {
        walk(treeNode.children, treeNode.id, col);
      }
    }
  }

  walk(tree, null, 0);

  // Reorder technologies to match tree traversal order.
  // Technologies not in the tree are appended at the end.
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
  DATA.technologies.sort((a, b) => {
    const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Infinity;
    const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Infinity;
    return ai - bi;
  });
}

// ── Layout Helpers ────────────────────────────────────────────────

function isLocked(tech) {
  return tech.unlock && tech.unlock.state === 'locked' && !unlockedIds.has(tech.id);
}

// Helper: get array of parent IDs (supports both parent and parents in layout)
function getLayoutParentIds(n) {
  if (!n.layout) return [];
  if (n.layout.parents && n.layout.parents.length) return n.layout.parents;
  if (n.layout.parent) return [n.layout.parent];
  return [];
}

// Resolve column positions.
// If layout.col is already set (e.g. by buildLayoutFromTree), use it directly.
// Otherwise fall back to parent + offset calculation.
function resolveColumns(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const resolved = new Map(); // id -> column
  
  function getCol(nodeId) {
    if (resolved.has(nodeId)) return resolved.get(nodeId);
    
    const node = byId.get(nodeId);
    if (!node) return 0;
    
    // If col is already set (e.g. from tree), use it directly
    if (node.layout && node.layout.col !== undefined) {
      resolved.set(nodeId, node.layout.col);
      return node.layout.col;
    }
    
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
    if (!n.layout) n.layout = {};
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
//   7. Clusters are compound nodes: one column, items stacked vertically
function computePositions(nodes) {
  // First, resolve column positions from parent + offset
  resolveColumns(nodes);

  const byId = new Map(nodes.map((n, i) => [n.id, { ...n, inputIdx: i }]));

  // Build cluster metadata lookups
  const clusters = DATA.clusters || [];
  const clusterById = new Map(clusters.map(c => [c.id, c]));
  const itemToCluster = new Map();
  for (const cm of clusters) {
    for (const mid of cm.members) {
      itemToCluster.set(mid, cm.id);
    }
  }

  // Step 1: Create placeholders for edges that span multiple columns
  const placeholders = [];
  const placeholderMap = new Map();
  const nodeToPlaceholderCluster = new Map();

  const skipEdgeGroups = new Map();

  nodes.forEach((n, inputIdx) => {
    const parentIds = getLayoutParentIds(n);
    for (const pid of parentIds) {
      // Resolve parent column: might be a cluster id or a regular node
      let parentCol;
      if (clusterById.has(pid)) {
        parentCol = clusterById.get(pid).col;
      } else {
        const parentNode = byId.get(pid);
        if (!parentNode) continue;
        parentCol = parentNode.layout.col;
      }
      if (n.layout.col <= parentCol + 1) continue;

      for (let col = parentCol + 1; col < n.layout.col; col++) {
        const groupKey = `${pid}-${col}`;
        if (!skipEdgeGroups.has(groupKey)) {
          skipEdgeGroups.set(groupKey, { parentId: pid, parentCol, col, children: [] });
        }
        skipEdgeGroups.get(groupKey).children.push({ node: n, inputIdx });
      }
    }
  });

  const realNodesAtCol = new Map();
  nodes.forEach((n, inputIdx) => {
    if (!realNodesAtCol.has(n.layout.col)) realNodesAtCol.set(n.layout.col, []);
    realNodesAtCol.get(n.layout.col).push({ node: n, inputIdx });
  });

  for (const [groupKey, group] of skipEdgeGroups) {
    const { parentId, parentCol, col, children } = group;
    const realNodes = realNodesAtCol.get(col) || [];

    children.sort((a, b) => a.inputIdx - b.inputIdx);
    const sortedRealNodes = [...realNodes].sort((a, b) => a.inputIdx - b.inputIdx);

    let clusterIdx = 0;
    let realNodePointer = 0;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if (i > 0) {
        const prevChildIdx = children[i - 1].inputIdx;
        const currChildIdx = child.inputIdx;

        while (realNodePointer < sortedRealNodes.length &&
               sortedRealNodes[realNodePointer].inputIdx < currChildIdx) {
          if (sortedRealNodes[realNodePointer].inputIdx > prevChildIdx) {
            clusterIdx++;
            break;
          }
          realNodePointer++;
        }
      }

      nodeToPlaceholderCluster.set(`${child.node.id}-${parentId}-${col}`, clusterIdx);

      const phKey = `${parentId}-${col}-${clusterIdx}`;
      if (!placeholderMap.has(phKey)) {
        const prevPhKey = `${parentId}-${col - 1}-${clusterIdx}`;

        placeholders.push({
          id: `ph-${phKey}`,
          layout: { col: col },
          parent: col === parentCol + 1 ? parentId : `ph-${prevPhKey}`,
          isPlaceholder: true,
          inputIdx: child.inputIdx,
        });
        placeholderMap.set(phKey, placeholders[placeholders.length - 1]);
      }
    }
  }

  // Compute layoutParents: for each node, list of layout parent IDs
  const layoutParents = new Map();
  nodes.forEach(n => {
    const parentIds = getLayoutParentIds(n);
    if (parentIds.length === 0) {
      layoutParents.set(n.id, []);
    } else {
      const lps = parentIds.map(pid => {
        let parentCol;
        if (clusterById.has(pid)) {
          parentCol = clusterById.get(pid).col;
        } else {
          const parentNode = byId.get(pid);
          if (!parentNode) return pid;
          parentCol = parentNode.layout.col;
        }

        if (n.layout.col > parentCol + 1) {
          const clusterKey = `${n.id}-${pid}-${n.layout.col - 1}`;
          const ci = nodeToPlaceholderCluster.get(clusterKey) || 0;
          return `ph-${pid}-${n.layout.col - 1}-${ci}`;
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

  columns.forEach(items => items.sort((a, b) => a.inputIdx - b.inputIdx));

  const sortedCols = [...columns.keys()].sort((a, b) => a - b);
  const maxCol = Math.max(...sortedCols);

  // Step 2: Build children map
  const childrenOf = new Map();
  allItems.forEach(item => {
    const lps = layoutParents.get(item.id) || (item.parent ? [item.parent] : []);
    for (const pid of lps) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(item);
    }
  });

  // Step 3: Compute subtree height (right-to-left)
  const subtreeHeight = new Map();

  for (let col = maxCol; col >= 0; col--) {
    const items = columns.get(col) || [];
    for (const item of items) {
      const children = childrenOf.get(item.id) || [];
      const singleParentChildren = children.filter(c => {
        const lps = layoutParents.get(c.id) || (c.parent ? [c.parent] : []);
        return lps.length === 1;
      });

      if (singleParentChildren.length === 0) {
        subtreeHeight.set(item.id, cfg.boxH);
      } else if (item.isPlaceholder) {
        // Placeholders are invisible routing waypoints. Their subtree
        // lives in later columns, so don't claim that vertical space
        // in the intermediate column — just take one box height.
        subtreeHeight.set(item.id, cfg.boxH);
      } else {
        const childHeights = singleParentChildren.map(c => subtreeHeight.get(c.id) || cfg.boxH);
        const totalHeight = childHeights.reduce((sum, h) => sum + h, 0) + (singleParentChildren.length - 1) * cfg.gapY;
        subtreeHeight.set(item.id, totalHeight);
      }
    }
  }

  // Cluster subtree heights: sum of item subtree heights + gaps
  for (const cm of clusters) {
    const itemHeights = cm.members.map(id => subtreeHeight.get(id) || cfg.boxH);
    const clusterH = itemHeights.reduce((sum, h) => sum + h, 0) + (cm.members.length - 1) * cfg.gapY;
    subtreeHeight.set(cm.id, clusterH);
  }

  // Step 4: Position nodes left-to-right
  const relY = new Map();

  // First, position cluster items as a group
  for (const cm of clusters) {
    let parentCenterY = 0;
    if (cm.parentIds && cm.parentIds.length > 0) {
      const pys = cm.parentIds.map(pid => relY.get(pid)).filter(y => y !== undefined);
      if (pys.length > 0) {
        parentCenterY = pys.reduce((a, b) => a + b, 0) / pys.length;
      }
    }

    const itemHeights = cm.members.map(id => subtreeHeight.get(id) || cfg.boxH);
    const totalSpan = itemHeights.reduce((sum, h) => sum + h, 0) + (cm.members.length - 1) * cfg.gapY;

    let currentY = parentCenterY - totalSpan / 2;
    cm.members.forEach((itemId, i) => {
      const h = itemHeights[i];
      relY.set(itemId, currentY + h / 2);
      currentY += h + cfg.gapY;
    });

    const firstItemY = relY.get(cm.members[0]);
    const lastItemY = relY.get(cm.members[cm.members.length - 1]);
    relY.set(cm.id, (firstItemY + lastItemY) / 2);
  }

  for (const col of sortedCols) {
    const items = columns.get(col);

    const singleParentItems = [];
    const multiParentItems = [];

    items.forEach(item => {
      // Skip cluster items — already positioned
      if (item.layout._clusterId) return;

      const lps = layoutParents.get(item.id) || (item.parent ? [item.parent] : []);
      if (lps.length <= 1) {
        singleParentItems.push(item);
      } else {
        multiParentItems.push(item);
      }
    });

    const byParent = new Map();
    singleParentItems.forEach(item => {
      const lps = layoutParents.get(item.id) || (item.parent ? [item.parent] : []);
      const pid = lps[0] || "__root__";
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(item);
    });

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

    // Collision resolution: all items in column including cluster items
    const allColItems = [...items].sort((a, b) => a.inputIdx - b.inputIdx);

    for (let i = 1; i < allColItems.length; i++) {
      const prev = allColItems[i - 1];
      const curr = allColItems[i];

      // Use boxH (not subtreeHeight) for collision resolution.
      // Subtree heights already handled spacing during the positioning
      // phase; collision resolution just prevents box-to-box overlaps
      // between nodes from different parents sharing a column.
      const prevBottom = relY.get(prev.id) + cfg.boxH / 2;
      const currTop = relY.get(curr.id) - cfg.boxH / 2;
      const overlap = prevBottom + cfg.gapY - currTop;

      if (overlap > 0) {
        for (let j = i; j < allColItems.length; j++) {
          relY.set(allColItems[j].id, relY.get(allColItems[j].id) + overlap);
        }
      }
    }
  }

  // Update cluster center Y after collision resolution
  for (const cm of clusters) {
    const firstItemY = relY.get(cm.members[0]);
    const lastItemY = relY.get(cm.members[cm.members.length - 1]);
    relY.set(cm.id, (firstItemY + lastItemY) / 2);
  }

  // Step 5: Convert relative positions to absolute canvas positions
  let minRelY = Infinity;
  relY.forEach(y => { if (isFinite(y)) minRelY = Math.min(minRelY, y); });

  const offsetY = cfg.marginY + cfg.boxH / 2 - minRelY;

  const pos = new Map();
  allItems.forEach(item => {
    const centerY = relY.get(item.id);
    if (centerY === undefined) return;
    const x = cfg.marginX + item.layout.col * (cfg.boxW + cfg.gapX);
    const y = centerY + offsetY - cfg.boxH / 2;
    pos.set(item.id, {
      x, y,
      col: item.layout.col,
      isPlaceholder: item.isPlaceholder,
      centerY: centerY + offsetY
    });
  });

  // Store cluster bounding-box positions for edge routing and rendering
  for (const cm of clusters) {
    const centerY = relY.get(cm.id) + offsetY;
    const x = cfg.marginX + cm.col * (cfg.boxW + cfg.gapX);
    const itemPositions = cm.members.map(id => pos.get(id)).filter(Boolean);
    if (!itemPositions.length) continue;
    const minItemY = Math.min(...itemPositions.map(p => p.y));
    const maxItemY = Math.max(...itemPositions.map(p => p.y + cfg.boxH));
    pos.set(cm.id, {
      x: x - cfg.clusterPad,
      y: minItemY - cfg.clusterPad,
      col: cm.col,
      isCluster: true,
      centerY: centerY,
      clusterW: cfg.boxW + cfg.clusterPad * 2,
      clusterH: (maxItemY - minItemY) + cfg.clusterPad * 2,
      clusterRight: x + cfg.boxW + cfg.clusterPad,
      clusterLeft: x - cfg.clusterPad,
    });
  }

  return { pos, nodeToPlaceholderCluster };
}

// Edge routing helpers
function midRight(p) {
  if (p.isCluster) return { x: p.clusterRight, y: p.centerY };
  return { x: p.x + cfg.boxW, y: p.centerY };
}
function midLeft(p) {
  if (p.isCluster) return { x: p.clusterLeft, y: p.centerY };
  return { x: p.x, y: p.centerY };
}

function betweenColsX(colA, colB) {
  const xRightA = cfg.marginX + colA * (cfg.boxW + cfg.gapX) + cfg.boxW;
  const xLeftB  = cfg.marginX + colB * (cfg.boxW + cfg.gapX);
  return (xRightA + xLeftB) / 2;
}

function routeEdge(parentId, childId, pos, nodeToPlaceholderCluster) {
  const p = pos.get(parentId);
  const c = pos.get(childId);
  if (!p || !c) return [];
  const S = midRight(p);
  const E = midLeft(c);
  
  const pts = [S];
  
  // Collect waypoints: placeholders in intermediate columns (cluster-specific)
  const waypoints = [];
  for (let col = p.col + 1; col < c.col; col++) {
    const clusterKey = `${childId}-${parentId}-${col}`;
    const clusterIdx = nodeToPlaceholderCluster.get(clusterKey) || 0;
    const phId = `ph-${parentId}-${col}-${clusterIdx}`;
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

  // Calculate wrapper dimensions from positions (including cluster boxes)
  let maxX = 0, maxY = 0;
  pos.forEach(p => {
    if (p.isPlaceholder) return;
    if (p.isCluster) {
      maxX = Math.max(maxX, p.x + p.clusterW);
      maxY = Math.max(maxY, p.y + p.clusterH);
    } else {
      maxX = Math.max(maxX, p.x + cfg.boxW);
      maxY = Math.max(maxY, p.y + cfg.boxH);
    }
  });
  const wrapperW = maxX + cfg.marginX;
  const wrapperH = maxY + cfg.marginY;

  const treeInstructionsId = 'tree-instructions';

  // Build node HTML (absolutely positioned)
  let nodesHtml = '';
  techs.forEach(tech => {
    const p = pos.get(tech.id);
    const locked = isLocked(tech);
    const lockedClass = locked ? ' node-locked' : '';
    const clusterNodeClass = tech._clusterNode ? ' tree-node--cluster-node' : '';

    const iconHtml = techIconHtml(tech, 'node-icon-img');
    const badgeHtml = renderTechBadge(tech.badge, 'tree');
    const actionText = tech._clusterNode ? 'Opens cluster details.' : 'Opens protocol details.';
    const stateText = locked ? 'Locked. Activate to unlock.' : 'Unlocked.';
    const ariaLabel = `${tech.title}${tech.tagline ? ': ' + tech.tagline : ''}. ${stateText} ${actionText}`;

    nodesHtml += `
      <button type="button" class="tree-node${lockedClass}${clusterNodeClass}"
           data-id="${tech.id}"
           ${tech._clusterNode ? 'data-cluster-node="true"' : ''}
           aria-label="${escapeHtml(ariaLabel)}"
           aria-describedby="${treeInstructionsId}"
           style="left:${p.x}px;top:${p.y}px;width:${cfg.boxW}px;height:${cfg.boxH}px;">
        <div class="node-header">
          <div class="node-icon" aria-hidden="true">${iconHtml}</div>
          <div class="node-title">${escapeHtml(tech.title)}</div>
        </div>
        <div class="node-tagline">${escapeHtml(tech.tagline)}</div>
        ${badgeHtml}
      </button>`;
  });

  // Build SVG connections using edge routing (supports multiple parents)
  let svgPaths = '';
  svgPaths += `<defs>
    <marker id="ah" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
      <polygon points="0 0, 10 4, 0 8" class="arrow-head"/>
    </marker>
  </defs>`;

  // Draw edges: cluster-level parent edges + regular node edges
  // 1. Cluster-level parent edges (e.g., a2a -> c-domain)
  (DATA.clusters || []).forEach(cluster => {
    (cluster.parentIds || []).forEach(pid => {
      const pts = routeEdge(pid, cluster.id, pos, nodeToPlaceholderCluster);
      if (pts.length) {
        svgPaths += `<path d="${polylinePath(pts)}" marker-end="url(#ah)"/>`;
      }
    });
  });

  // 2. Regular node edges (parent is a node, cluster, or item)
  techs.forEach(tech => {
    const parentIds = getLayoutParentIds(tech);
    for (const pid of parentIds) {
      const pts = routeEdge(pid, tech.id, pos, nodeToPlaceholderCluster);
      if (pts.length) {
        svgPaths += `<path d="${polylinePath(pts)}" marker-end="url(#ah)"/>`;
      }
    }
  });

  // Build cluster outlines (positions computed by layout engine)
  let clustersHtml = '';
  (DATA.clusters || []).forEach(cluster => {
    const cp = pos.get(cluster.id);
    if (!cp) return;
    const hasDesc = cluster.description && cluster.description.trim();
    const labelTag = hasDesc
      ? `<button type="button" class="tree-group-label tree-group-label--clickable" onclick="showClusterModal('${escapeHtml(cluster.id)}')" aria-label="${escapeHtml(cluster.label)} cluster details">${escapeHtml(cluster.label)} <span class="tree-group-info">[?]</span></button>`
      : `<span class="tree-group-label">${escapeHtml(cluster.label)}</span>`;
    clustersHtml += `
      <div class="tree-group" style="left:${cp.x}px;top:${cp.y}px;width:${cp.clusterW}px;height:${cp.clusterH}px">
        ${labelTag}
      </div>`;
  });

  const readMoreBtn = DATA.details ? `<button type="button" class="read-more-btn" onclick="showDetailsModal()">About &gt;</button>` : '';

  document.getElementById('app').innerHTML = `
    <div class="tree-page">
      <header class="tree-header">
        <div class="tree-header-text">
          <h1>${escapeHtml(DATA.title)}</h1>
          <p>${escapeHtml(DATA.subtitle)}</p>
          ${readMoreBtn}
        </div>
        <div class="tree-header-right">
          ${getToolbarHtml()}
          ${getAttributionHtml()}
        </div>
      </header>
      <main class="tree-container" id="tree-main" tabindex="0" aria-label="Protocol dependency tree" aria-describedby="${treeInstructionsId}">
        <p id="${treeInstructionsId}" class="sr-only">Use arrow keys to pan the tree. Use Tab to move between protocol nodes, then press Enter or Space to open.</p>
        <div class="tree-wrapper" style="width:${wrapperW}px;height:${wrapperH}px">
          <svg class="tree-svg" width="${wrapperW}" height="${wrapperH}" viewBox="0 0 ${wrapperW} ${wrapperH}" aria-hidden="true">
            ${svgPaths}
          </svg>
          ${clustersHtml}
          ${nodesHtml}
        </div>
      </main>
      <footer class="tree-footer">Click or focus a node and press Enter to explore how it works</footer>
    </div>`;

  attachToolbarListeners();

  // Initial viewport: left edge + vertically centered on leftmost column
  const treeContainer = document.querySelector('.tree-container');
  if (treeContainer) {
    treeContainer.addEventListener('keydown', (e) => {
      if (e.target !== treeContainer) return;
      const step = 120;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        treeContainer.scrollLeft += step;
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        treeContainer.scrollLeft -= step;
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        treeContainer.scrollTop += step;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        treeContainer.scrollTop -= step;
      } else if (e.key === 'Home') {
        e.preventDefault();
        treeContainer.scrollLeft = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        treeContainer.scrollLeft = treeContainer.scrollWidth;
      }
    });

    const visibleItems = [...pos.values()].filter(p => !p.isPlaceholder);
    const leftmostCol = visibleItems.length
      ? Math.min(...visibleItems.map(p => p.col))
      : 0;
    const leftColItems = visibleItems.filter(p => p.col === leftmostCol);

    let leftColTop = 0;
    let leftColBottom = wrapperH;
    if (leftColItems.length) {
      leftColTop = Math.min(...leftColItems.map(p => p.y));
      leftColBottom = Math.max(...leftColItems.map(p => p.y + (p.isCluster ? p.clusterH : cfg.boxH)));
    }

    requestAnimationFrame(() => {
      treeContainer.scrollLeft = 0;
      const leftColCenterY = (leftColTop + leftColBottom) / 2;
      const targetTop = leftColCenterY - (treeContainer.clientHeight / 2);
      const maxTop = Math.max(0, treeContainer.scrollHeight - treeContainer.clientHeight);
      treeContainer.scrollTop = Math.max(0, Math.min(maxTop, targetTop));
    });
  }

  // Attach click handlers (locked node: unlock + open on same click)
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
        if (node.dataset.clusterNode) {
          showClusterModal(id);
        } else {
          navigateTo(id);
        }
      } else if (node.dataset.clusterNode) {
        // Cluster-node: show description modal
        showClusterModal(id);
      } else {
        navigateTo(id);
      }
    }
    node.addEventListener('click', handleClick);
  });

}

// ================================================================
//  SHARED HELPERS (detail + reader)
// ================================================================

// Build "unlocked by" / "unlocks" relationship HTML for a given tech
function buildRelHtml(techId) {
  const tech = DATA.technologies.find(t => t.id === techId);
  if (!tech) return '';

  const clusters = DATA.clusters || [];
  const clusterIds = new Set(clusters.map(c => c.id));
  const clusterById = new Map(clusters.map(c => [c.id, c]));

  // Resolve parents: if a parent is a cluster, expand to its member techs
  const rawParentIds = getLayoutParentIds(tech);
  const resolvedParentIds = [];
  for (const pid of rawParentIds) {
    if (clusterById.has(pid)) {
      resolvedParentIds.push(...clusterById.get(pid).members);
    } else {
      resolvedParentIds.push(pid);
    }
  }

  // Find children: techs whose parent is this techId, plus
  // if this tech is inside a cluster, also find techs parented to that cluster
  const childTechs = DATA.technologies.filter(t => {
    const pids = getLayoutParentIds(t);
    return pids.includes(techId);
  });
  // Also check if any cluster is parented to this tech
  for (const cm of clusters) {
    if ((cm.parentIds || []).includes(techId)) {
      // Add the cluster's members as children
      for (const mid of cm.members) {
        const memberTech = DATA.technologies.find(t => t.id === mid);
        if (memberTech && !childTechs.includes(memberTech)) {
          childTechs.push(memberTech);
        }
      }
    }
  }

  if (!resolvedParentIds.length && !childTechs.length) return '';

  function renderRelGroup(label, techs) {
    if (!techs.length) return '';
    return `
      <div class="tree-rel tree-rel--${label === 'Unlocked by' ? 'parents' : 'children'}">
        <span class="tree-rel-label">${label}</span>
        <div class="tree-rel-nodes">
          ${techs.map(t => {
            const iconHtml = techIconHtml(t, 'tree-rel-icon-img');
            return `<a href="#${t.id}" class="tree-rel-node">
              <span class="tree-rel-icon">${iconHtml}</span>
              <span class="tree-rel-title">${escapeHtml(t.title)}</span>
            </a>`;
          }).join('')}
        </div>
      </div>`;
  }

  const parentTechs = resolvedParentIds.map(pid => DATA.technologies.find(t => t.id === pid)).filter(Boolean);
  return `<div class="tree-rel-bar">${renderRelGroup('Unlocked by', parentTechs)}${renderRelGroup('Unlocks', childTechs)}</div>`;
}

// ================================================================
//  DETAIL VIEW
// ================================================================

function showDetail(techId) {
  currentView = 'detail';
  currentProtocolId = techId;

  const tech = DATA.technologies.find(t => t.id === techId);
  if (!tech) { navigateTo(''); return; }

  // Auto-unlock if navigated directly via URL hash
  if (tech.unlock && tech.unlock.state === 'locked') {
    unlockedIds.add(techId);
  }

  document.title = `${tech.title} — ${DATA.title}`;

  const detail = tech.detail;
  const hasAnimation = tech.animation && tech.animation.scenes && tech.animation.scenes.length > 0;

  // Links list (rendered at bottom)
  let linksHtml = '';
  if (detail.links && detail.links.length) {
    linksHtml = `
      <div class="detail-section detail-links-section">
        <h2 class="section-label">Links</h2>
        <ul class="detail-links-list">
          ${detail.links.map(link =>
            `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="detail-link-item">${escapeHtml(link.label)}</a></li>`
          ).join('')}
        </ul>
      </div>`;
  }

  const relHtml = buildRelHtml(techId);

  // How it works (static scenes)
  let scenesHtml = '';
  if (hasAnimation) {
    const scenes = tech.animation.scenes;
    scenesHtml = `
      <div class="detail-section">
        <h2 class="section-label">How it works</h2>
        <div class="reader-scenes">
          ${scenes.map((scene, i) => renderStaticScene(scene, tech.animation.actors, i, scenes.length, techId)).join('')}
        </div>
      </div>`;
  }

  // Virtuous cycle (array → <ul>)
  let cycleHtml = '';
  if (detail.virtuous_cycle && detail.virtuous_cycle.length) {
    cycleHtml = `
      <div class="detail-section">
        <h2 class="section-label">The virtuous cycle</h2>
        <ul class="virtuous-cycle">
          ${detail.virtuous_cycle.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>`;
  }

  // Icon for hero (larger)
  const heroIconHtml = techIconHtml(tech, 'hero-icon-img');

  document.getElementById('app').innerHTML = `
    <div class="detail-page">
      <header class="detail-header">
        <button type="button" class="back-btn" onclick="navigateTo('')">&larr; Tree</button>
        ${getToolbarHtml()}
      </header>
      <main class="detail-content" id="detail-main">
        <div class="detail-hero">
          <div class="hero-icon" aria-hidden="true">${heroIconHtml}</div>
          <div class="hero-text">
            <h1 class="hero-title">${escapeHtml(tech.title)}${renderTechBadge(tech.badge, 'detail')}</h1>
            <div class="tagline">${escapeHtml(tech.tagline)}</div>
          </div>
          ${relHtml}
        </div>

        <div class="detail-section">
          <h2 class="section-label">What it solves</h2>
          <div class="section-body">${escapeHtml(detail.what_it_solves)}</div>
        </div>

        ${scenesHtml}

        <div class="detail-section">
          <h2 class="section-label">How it&rsquo;s standardizing</h2>
          <div class="section-body">${escapeHtml(detail.how_its_standardizing)}</div>
        </div>

        ${cycleHtml}

        ${linksHtml}
      </main>
    </div>`;

  // Attach toolbar listeners
  attachToolbarListeners();

  // Scroll to top
  window.scrollTo(0, 0);
}

// ================================================================
//  READER MODE
// ================================================================

function showReader() {
  currentView = 'reader';
  currentProtocolId = null;
  document.title = `Reader — ${DATA.title}`;

  const techs = DATA.technologies;
  const clusters = DATA.clusters || [];

  // Build cluster lookup: member id -> cluster
  const memberToCluster = new Map();
  clusters.forEach(cluster => {
    (cluster.members || []).forEach(mid => {
      memberToCluster.set(mid, cluster);
    });
  });

  // Group technologies by toc_group (default 0)
  const groupMap = new Map();
  techs.forEach(t => {
    const g = t.toc_group || 0;
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g).push(t);
  });
  const sortedGroups = [...groupMap.keys()].sort((a, b) => a - b);

  // Build subtrees per group, concatenating roots across groups.
  // Parent links that cross group boundaries are ignored.
  const allRoots = [];       // [{type: 'cluster'|'tech', item}]
  const childrenOf = new Map(); // id -> [{type, item}]
  const clustersInserted = new Set();

  for (const groupNum of sortedGroups) {
    const groupTechs = groupMap.get(groupNum);
    const groupIds = new Set(groupTechs.map(t => t.id));

    groupTechs.forEach(t => {
      // Only keep parents within this toc_group
      const parentIds = getLayoutParentIds(t).filter(pid => groupIds.has(pid));
      const cluster = memberToCluster.get(t.id);

      // Helper: add entry under a parent or as root
      function addEntry(entry, parentId) {
        if (parentId) {
          if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
          childrenOf.get(parentId).push(entry);
        } else {
          allRoots.push(entry);
        }
      }

      // Cluster-node techs (display: node) render like clusters in reader
      if (t._clusterNode) {
        const parentId = parentIds.length > 0 ? parentIds[0] : null;
        addEntry({
          type: 'cluster',
          item: { id: t.id, label: t._clusterLabel, description: t._clusterDescription }
        }, parentId);
        return;
      }

      if (cluster && !clustersInserted.has(cluster.id)) {
        // First member of a cluster: insert the cluster node, then tech under it
        clustersInserted.add(cluster.id);
        const parentId = parentIds.length > 0 ? parentIds[0] : null;
        addEntry({ type: 'cluster', item: cluster }, parentId);
        if (!childrenOf.has(cluster.id)) childrenOf.set(cluster.id, []);
        childrenOf.get(cluster.id).push({ type: 'tech', item: t });
      } else if (cluster) {
        // Subsequent cluster member: add under cluster
        if (!childrenOf.has(cluster.id)) childrenOf.set(cluster.id, []);
        childrenOf.get(cluster.id).push({ type: 'tech', item: t });
      } else if (parentIds.length === 0) {
        allRoots.push({ type: 'tech', item: t });
      } else {
        const pid = parentIds[0];
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid).push({ type: 'tech', item: t });
      }
    });
  }

  // ── Render TOC tree recursively ──
  function renderTocItem(entry) {
    const id = entry.type === 'cluster' ? entry.item.id : entry.item.id;
    const label = entry.type === 'cluster' ? entry.item.label : entry.item.title;
    const kids = childrenOf.get(id) || [];
    const cssClass = entry.type === 'cluster' ? 'reader-toc-link reader-toc-link--cluster' : 'reader-toc-link';
    let html = `<li><a href="#reader-${id}" class="${cssClass}" data-target="reader-${id}" aria-controls="reader-${id}" onclick="readerScrollTo('reader-${id}'); event.preventDefault();">${escapeHtml(label)}</a>`;
    if (kids.length) {
      html += '<ul>' + kids.map(renderTocItem).join('') + '</ul>';
    }
    html += '</li>';
    return html;
  }
  const tocHtml = '<ul class="reader-toc-tree">' + allRoots.map(renderTocItem).join('') + '</ul>';

  // ── Render content in tree order ──
  let sectionsHtml = '';

  function renderContentTree(entries) {
    entries.forEach(entry => {
      if (entry.type === 'cluster') {
        const cluster = entry.item;
        const hasDesc = cluster.description && cluster.description.trim();
        sectionsHtml += `
          <article class="reader-article reader-article--cluster" id="reader-${cluster.id}">
            <div class="detail-hero">
              <div class="hero-text">
                <h2 class="hero-title">${escapeHtml(cluster.label)}</h2>
              </div>
            </div>
            ${hasDesc ? `<div class="detail-section"><div class="section-body">${escapeHtml(cluster.description)}</div></div>` : ''}
          </article>`;
      } else {
        sectionsHtml += renderTechArticle(entry.item);
      }
      const kids = childrenOf.get(entry.type === 'cluster' ? entry.item.id : entry.item.id) || [];
      renderContentTree(kids);
    });
  }
  renderContentTree(allRoots);

  document.getElementById('app').innerHTML = `
    <div class="reader-page">
      <header class="detail-header">
        <button type="button" class="back-btn" onclick="navigateTo('')">&larr; Tree</button>
        ${getToolbarHtml()}
      </header>
      <div class="reader-layout">
        <nav class="reader-toc" id="reader-toc" aria-label="Protocol table of contents">
          <div class="reader-toc-header">${escapeHtml(DATA.title)}</div>
          ${tocHtml}
        </nav>
        <main class="reader-content" id="reader-main">
          ${sectionsHtml}
        </main>
      </div>
    </div>`;

  attachToolbarListeners();
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('reader-')) {
    readerScrollTo(hash, { updateHash: false });
  } else {
    window.scrollTo(0, 0);
  }

  // Highlight active TOC item on scroll
  setupReaderScrollSpy();
}

// ── Tech Article HTML (used by reader mode) ───────────────────────
function renderTechArticle(tech) {
  const detail = tech.detail;
  const hasAnimation = tech.animation && tech.animation.scenes && tech.animation.scenes.length > 0;

  // Icon
  const heroIconHtml = techIconHtml(tech, 'hero-icon-img');

  // Links (rendered at bottom)
  let linksHtml = '';
  if (detail.links && detail.links.length) {
    linksHtml = `
      <div class="detail-section detail-links-section">
        <h3 class="section-label">Links</h3>
        <ul class="detail-links-list">
          ${detail.links.map(link =>
            `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="detail-link-item">${escapeHtml(link.label)}</a></li>`
          ).join('')}
        </ul>
      </div>`;
  }

  // Static animation scenes
  let scenesHtml = '';
  if (hasAnimation) {
    const scenes = tech.animation.scenes;
    scenesHtml = `
      <div class="detail-section">
        <h3 class="section-label">How it works</h3>
        <div class="reader-scenes">
          ${scenes.map((scene, i) => renderStaticScene(scene, tech.animation.actors, i, scenes.length, tech.id)).join('')}
        </div>
      </div>`;
  }

  // Virtuous cycle
  let cycleHtml = '';
  if (detail.virtuous_cycle && detail.virtuous_cycle.length) {
    cycleHtml = `
      <div class="detail-section">
        <h3 class="section-label">The virtuous cycle</h3>
        <ul class="virtuous-cycle">
          ${detail.virtuous_cycle.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>`;
  }

  const relHtml = buildRelHtml(tech.id);

  return `
    <article class="reader-article" id="reader-${tech.id}">
      <div class="detail-hero">
        <div class="hero-icon" aria-hidden="true">${heroIconHtml}</div>
        <div class="hero-text">
          <h2 class="hero-title"><a href="#${tech.id}" class="reader-detail-link">${escapeHtml(tech.title)}</a>${renderTechBadge(tech.badge, 'detail')}</h2>
          <div class="tagline">${escapeHtml(tech.tagline)}</div>
        </div>
        ${relHtml}
      </div>

      <div class="detail-section">
        <h3 class="section-label">What it solves</h3>
        <div class="section-body">${escapeHtml(detail.what_it_solves)}</div>
      </div>

      ${scenesHtml}

      <div class="detail-section">
        <h3 class="section-label">How it&rsquo;s standardizing</h3>
        <div class="section-body">${escapeHtml(detail.how_its_standardizing)}</div>
      </div>

      ${cycleHtml}

      ${linksHtml}
    </article>`;
}

function renderStaticScene(scene, allActors, sceneIdx, totalScenes, techId) {
  const visibleIds = scene.actors_visible;
  const n = visibleIds.length;

  // Actors
  let actorsHtml = '<div class="anim-actors">';
  allActors.forEach(actor => {
    const visibleIdx = visibleIds.indexOf(actor.id);
    if (visibleIdx < 0) return;

    const leftPct = ((visibleIdx + 0.5) / n) * 100;
    const iconContent = actorIconHtml(actor.type);

    actorsHtml += `
      <div class="anim-actor" style="left:${leftPct}%;opacity:1;">
        <div class="actor-icon">${iconContent}</div>
        <div class="actor-label">${escapeHtml(actor.label)}</div>
      </div>`;
  });
  actorsHtml += '</div>';

  // Messages
  let msgsHtml = '<div class="anim-messages">';
  scene.messages.forEach((msg, mi) => {
    const fromIdx = visibleIds.indexOf(msg.from);
    const toIdx = visibleIds.indexOf(msg.to);
    if (fromIdx < 0 || toIdx < 0) return;

    const fromPct = ((fromIdx + 0.5) / n) * 100;
    const toPct = ((toIdx + 0.5) / n) * 100;
    const leftPct = Math.min(fromPct, toPct);
    const widthPct = Math.abs(toPct - fromPct);
    const direction = toPct > fromPct ? 'right' : 'left';

    const hasPreview = msg.json_preview && msg.json_preview.trim();
    const detailContent = (msg.json_full && msg.json_full.trim()) || msg.json_preview || '';
    const detailId = `reader-msg-${techId}-${sceneIdx}-${mi}`;

    msgsHtml += `
      <div class="anim-message">
        <div class="msg-label" style="margin-left:${leftPct}%;width:${widthPct}%">
          ${escapeHtml(msg.label)}
        </div>
        <div class="msg-arrow" style="margin-left:${leftPct}%;width:${widthPct}%">
          <div class="msg-arrow-head ${direction}"></div>
        </div>
        ${hasPreview ? `
          <button type="button" class="msg-preview msg-preview-btn expandable" style="margin-left:${Math.max(0, leftPct - 5)}%;width:${Math.min(100, widthPct + 10)}%"
               onclick="toggleDetail('${detailId}', '${escapeHtml(msg.label).replace(/'/g, "\\'")}'); event.stopPropagation();" aria-haspopup="dialog" aria-controls="json-modal" title="Open full message">
            <code>${escapeHtml(msg.json_preview)}</code> <span class="expand-hint">[+]</span>
          </button>
          <div class="msg-detail" id="${detailId}" style="display:none;">${escapeHtml(detailContent.trim())}</div>` : ''}
      </div>`;
  });
  msgsHtml += '</div>';

  return `
    <div class="reader-scene">
      <div class="reader-scene-text">
        <div class="step__number">Step ${sceneIdx + 1} of ${totalScenes}</div>
        <div class="step__title">${escapeHtml(scene.title)}</div>
        <div class="step__description">${escapeHtml(scene.description)}</div>
      </div>
      <div class="reader-scene-stage">
        <div class="anim-stage">
          ${actorsHtml}
          ${msgsHtml}
        </div>
      </div>
    </div>`;
}

function readerScrollTo(targetId, options = {}) {
  const updateHash = options.updateHash !== false;
  const el = document.getElementById(targetId);
  if (el) {
    const headerH = document.querySelector('.detail-header')?.offsetHeight || 56;
    const y = el.getBoundingClientRect().top + window.scrollY - headerH - 12;
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    window.scrollTo({ top: y, behavior });
    focusElement(el);
  }
  // Update URL without triggering hashchange/route
  if (updateHash) {
    history.replaceState(null, '', '#' + targetId);
  }
}

function setupReaderScrollSpy() {
  const tocLinks = document.querySelectorAll('.reader-toc-link');
  const articles = document.querySelectorAll('.reader-article');
  if (!tocLinks.length || !articles.length) return;

  function onScroll() {
    // Find which article is currently in view
    let activeId = null;
    const scrollY = window.scrollY + 120; // offset for sticky header
    articles.forEach(article => {
      if (article.offsetTop <= scrollY) {
        activeId = article.id;
      }
    });

    tocLinks.forEach(link => {
      const target = link.getAttribute('data-target');
      if (target === activeId) {
        link.classList.add('active');
        link.setAttribute('aria-current', 'location');
      } else {
        link.classList.remove('active');
        link.removeAttribute('aria-current');
      }
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Store cleanup reference
  scrollObserver = {
    disconnect: () => {
      window.removeEventListener('scroll', onScroll);
    }
  };
}

// ── Modal for JSON Detail ─────────────────────────────────────────
function showModal(content, title) {
  // Try to reformat as indented JSON; fall back to raw content
  let displayContent = content;
  try {
    displayContent = JSON.stringify(JSON.parse(content), null, 2);
  } catch (e) {
    // Not valid JSON — show raw
  }
  openModal(title || 'Full Message', escapeHtml(displayContent), {
    bodyTag: 'pre',
    bodyClass: 'json-modal__code',
  });
}

function getModalFocusableEls(container) {
  const candidates = container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  return [...candidates].filter((el) => {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function handleModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key !== 'Tab') return;

  const content = e.currentTarget;
  const focusables = getModalFocusableEls(content);
  if (!focusables.length) {
    e.preventDefault();
    content.focus();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function openModal(title, bodyHtml, options = {}) {
  const bodyTag = options.bodyTag || 'div';
  const bodyClass = options.bodyClass || 'json-modal__body';

  const returnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeModal(false);
  modalReturnFocusEl = returnFocusEl;

  const modal = document.createElement('div');
  modal.className = 'json-modal';
  modal.id = 'json-modal';
  const titleId = 'json-modal-title';
  const bodyId = 'json-modal-body';
  modal.innerHTML = `
    <div class="json-modal__backdrop" onclick="closeModal()"></div>
    <div class="json-modal__content" role="dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${bodyId}" tabindex="-1">
      <div class="json-modal__header">
        <h2 class="json-modal__title" id="${titleId}">${escapeHtml(title)}</h2>
        <button type="button" class="json-modal__close" onclick="closeModal()" aria-label="Close">&times;</button>
      </div>
      <${bodyTag} class="${bodyClass}" id="${bodyId}">${bodyHtml}</${bodyTag}>
    </div>
  `;
  document.body.appendChild(modal);

  const modalContent = modal.querySelector('.json-modal__content');
  modalContent.addEventListener('keydown', handleModalKeydown);
  modal.querySelector('.json-modal__close').focus();
}

function closeModal(restoreFocus = true) {
  const modal = document.getElementById('json-modal');
  if (!modal) {
    modalReturnFocusEl = null;
    return;
  }
  modal.remove();
  if (restoreFocus && modalReturnFocusEl && document.contains(modalReturnFocusEl)) {
    modalReturnFocusEl.focus({ preventScroll: true });
  }
  modalReturnFocusEl = null;
}

// ── Details Modal (About) ─────────────────────────────────────
function showDetailsModal() {
  if (!DATA || !DATA.details) return;
  openModal('About This Project', DATA.details.trim(), {
    bodyTag: 'div',
    bodyClass: 'json-modal__body',
  });
}

// ── Cluster Description Modal ─────────────────────────────────────
function showClusterModal(clusterId) {
  if (!DATA) return;

  // Look up in regular clusters first, then check synthetic cluster-node techs
  let label, description;
  const cluster = (DATA.clusters || []).find(c => c.id === clusterId);
  if (cluster) {
    label = cluster.label;
    description = cluster.description;
  } else {
    const tech = DATA.technologies.find(t => t.id === clusterId && t._clusterNode);
    if (tech) {
      label = tech._clusterLabel;
      description = tech._clusterDescription;
    }
  }

  if (!label || !description) return;
  openModal(label, escapeHtml(description), {
    bodyTag: 'div',
    bodyClass: 'json-modal__body',
  });
}

// ── Toggle JSON Detail (legacy inline, now opens modal) ───────────
function toggleDetail(id, label) {
  const el = document.getElementById(id);
  if (!el) return;
  const content = el.textContent || el.innerText;
  showModal(content, label);
}

// ── Icon helpers (convention-based paths with onerror fallback) ───
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

function techIconHtml(tech, cssClass) {
  const alt = escapeHtml(tech.icon_alt);
  const src = `images/icon-${tech.id}.png`;
  return `<img src="${src}" alt="${alt}" class="${cssClass}" onerror="this.replaceWith(document.createTextNode('${alt}'))">`;
}

function renderTechBadge(badgeId, variant = 'detail') {
  if (!badgeId) return '';
  const badge = BADGE_DEFS[badgeId];
  if (!badge) return '';
  const label = badge.label || badgeId;
  return `<span class="tech-badge tech-badge--${escapeHtml(variant)} tech-badge--${escapeHtml(badgeId)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" data-badge-label="${escapeHtml(label)}"><span class="tech-badge__icon" aria-hidden="true">${badge.iconHtml}</span></span>`;
}

function actorIconHtml(actorType) {
  const alt = escapeHtml(actorIconText(actorType));
  const src = `images/actor-${actorType}.png`;
  return `<img src="${src}" alt="${alt}" class="actor-icon-img" onerror="this.replaceWith(document.createTextNode('${alt}'))">`;
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
