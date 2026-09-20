// FlowCartographer Interactive Topology Visualizer
// High-performance Hybrid SVG + Canvas Engine with Force Physics, Traffic Particles, and Blast Radius

class FlowVisualizer {
  constructor() {
    this.svg = document.getElementById('graphSvg');
    this.canvas = document.getElementById('particleCanvas');
    this.ctx = this.canvas.getContext('2d');

    this.hullsLayer = document.getElementById('namespaceHullsLayer');
    this.edgesLayer = document.getElementById('edgesLayer');
    this.nodesLayer = document.getElementById('nodesLayer');

    // Pan & Zoom State
    this.transform = { x: 0, y: 0, scale: 1 };
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };

    // Graph Data
    this.nodes = new Map(); // id -> node
    this.edges = [];        // array of edges
    this.particles = [];    // moving traffic particles
    this.selectedNodeId = null;
    this.blastRadiusNodeId = null;
    this.affectedNodeIds = new Set();
    this.affectedEdgeIds = new Set();

    // Filters & Mode
    this.namespaceFilter = 'all';
    this.protocolFilter = 'all';
    this.layoutMode = 'force'; // 'force' | 'tier'
    this.searchTerm = '';

    // Simulation control
    this.isSimRunning = true;
    this.anomalyActive = false;

    // Time-travel state
    this.historicalSnapshots = [];
    this.isLiveMode = true;

    this.initCanvasSize();
    this.initEventListeners();
    this.initEventSource();
    this.startPhysicsLoop();
    this.startParticleLoop();

    // Fetch initial historical snapshots
    this.fetchHistory();
  }

  initCanvasSize() {
    const rect = this.svg.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * window.devicePixelRatio;
    this.canvas.height = this.height * window.devicePixelRatio;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  initEventListeners() {
    window.addEventListener('resize', () => this.initCanvasSize());

    // Pan & Zoom
    this.svg.addEventListener('mousedown', (e) => {
      if (e.target === this.svg || e.target.tagName === 'svg' || e.target.classList.contains('hull-group')) {
        this.isPanning = true;
        this.panStart = { x: e.clientX - this.transform.x, y: e.clientY - this.transform.y };
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        this.transform.x = e.clientX - this.panStart.x;
        this.transform.y = e.clientY - this.panStart.y;
        this.updateTransform();
      }
    });

    window.addEventListener('mouseup', () => {
      this.isPanning = false;
    });

    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.min(Math.max(this.transform.scale * zoomFactor, 0.3), 3.0);

      // Zoom toward cursor
      const rect = this.svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      this.transform.x = mouseX - (mouseX - this.transform.x) * (newScale / this.transform.scale);
      this.transform.y = mouseY - (mouseY - this.transform.y) * (newScale / this.transform.scale);
      this.transform.scale = newScale;
      this.updateTransform();
    });

    // Zoom Buttons
    document.getElementById('zoomIn').addEventListener('click', () => {
      this.transform.scale = Math.min(this.transform.scale * 1.2, 3.0);
      this.updateTransform();
    });

    document.getElementById('zoomOut').addEventListener('click', () => {
      this.transform.scale = Math.max(this.transform.scale / 1.2, 0.3);
      this.updateTransform();
    });

    document.getElementById('btnResetView').addEventListener('click', () => {
      this.centerGraph();
    });

    // Filters
    document.getElementById('namespaceFilter').addEventListener('change', (e) => {
      this.namespaceFilter = e.target.value;
      this.render();
    });

    document.getElementById('protocolFilter').addEventListener('change', (e) => {
      this.protocolFilter = e.target.value;
      this.render();
    });

    document.getElementById('layoutMode').addEventListener('change', (e) => {
      this.layoutMode = e.target.value;
      this.applyLayoutPositions();
    });

    document.getElementById('serviceSearch').addEventListener('input', (e) => {
      this.searchTerm = e.target.value.toLowerCase().trim();
      this.render();
    });

    // Anomaly Toggle
    const btnAnomaly = document.getElementById('btnAnomaly');
    btnAnomaly.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/v1/simulate/anomaly', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'payment-service' })
        });
        const data = await resp.json();
        this.updateAnomalyState(data.active, data.targetNodeId);
      } catch (err) {
        console.error('Failed to toggle anomaly:', err);
      }
    });

    // Traffic Toggle
    const btnToggleSim = document.getElementById('btnToggleSim');
    btnToggleSim.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/v1/simulate/toggle', { method: 'POST' });
        const data = await resp.json();
        this.isSimRunning = data.running;
        document.getElementById('simToggleText').innerText = this.isSimRunning ? 'Pause Traffic' : 'Resume Traffic';
      } catch (err) {
        console.error('Failed to toggle simulation:', err);
      }
    });

    // Drawer Close
    document.getElementById('btnCloseDrawer').addEventListener('click', () => {
      this.closeInspector();
    });

    // Compute Blast Radius Button
    document.getElementById('btnComputeBlast').addEventListener('click', () => {
      if (this.selectedNodeId) {
        this.runBlastRadiusAnalysis(this.selectedNodeId);
      }
    });

    // Time Scrubber
    const timeSlider = document.getElementById('timeSlider');
    timeSlider.addEventListener('input', (e) => {
      const idx = parseInt(e.target.value, 10);
      this.scrubToHistoryIndex(idx);
    });

    document.getElementById('btnPlayHistory').addEventListener('click', () => {
      this.playHistory();
    });
  }

  updateTransform() {
    const tStr = `translate(${this.transform.x}px, ${this.transform.y}px) scale(${this.transform.scale})`;
    this.hullsLayer.style.transform = tStr;
    this.edgesLayer.style.transform = tStr;
    this.nodesLayer.style.transform = tStr;
  }

  centerGraph() {
    if (this.nodes.size === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of this.nodes.values()) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }

    const graphWidth = maxX - minX || 600;
    const graphHeight = maxY - minY || 400;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const scale = Math.min(Math.min((this.width * 0.8) / graphWidth, (this.height * 0.8) / graphHeight), 1.2);
    this.transform.scale = Math.max(0.6, scale);
    this.transform.x = this.width / 2 - cx * this.transform.scale;
    this.transform.y = this.height / 2 - cy * this.transform.scale;
    this.updateTransform();
  }

  // Connect to live Server-Sent Events stream from FlowCartographer server
  initEventSource() {
    const evtSource = new EventSource('/api/v1/stream');

    evtSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'SNAPSHOT') {
          this.syncGraphData(payload.data.nodes, payload.data.edges);
          this.updateAnomalyState(payload.data.anomalyActive, payload.data.anomalyNodeId);
          this.centerGraph();
        } else if (payload.type === 'METRICS_TICK') {
          if (this.isLiveMode) {
            this.updateMetrics(payload.nodes, payload.edges);
          }
        } else if (payload.type === 'ANOMALY_STATUS') {
          this.updateAnomalyState(payload.active, payload.targetNode);
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    evtSource.onerror = () => {
      document.getElementById('streamStatus').innerText = 'OFFLINE • RECONNECTING...';
      document.getElementById('streamStatus').style.color = 'var(--color-amber)';
    };

    evtSource.onopen = () => {
      document.getElementById('streamStatus').innerText = 'LIVE • SSE KERNEL STREAM';
      document.getElementById('streamStatus').style.color = 'var(--color-emerald)';
    };
  }

  updateAnomalyState(active, targetNodeId) {
    this.anomalyActive = active;
    const btn = document.getElementById('btnAnomaly');
    const text = document.getElementById('anomalyBtnText');

    if (active) {
      btn.classList.add('active');
      text.innerText = 'Reset Outage Anomaly';
      if (targetNodeId) {
        this.runBlastRadiusAnalysis(targetNodeId);
      }
    } else {
      btn.classList.remove('active');
      text.innerText = 'Inject Outage Anomaly';
      this.clearBlastRadius();
    }
  }

  syncGraphData(nodesData, edgesData) {
    // Preserve existing node positions
    for (const raw of nodesData) {
      if (!this.nodes.has(raw.id)) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 150 + Math.random() * 200;
        this.nodes.set(raw.id, {
          ...raw,
          x: this.width / 2 + Math.cos(angle) * radius,
          y: this.height / 2 + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
        });
      } else {
        const existing = this.nodes.get(raw.id);
        Object.assign(existing, raw);
      }
    }

    // Filter out deleted nodes
    const validIds = new Set(nodesData.map(n => n.id));
    for (const [id] of this.nodes) {
      if (!validIds.has(id)) this.nodes.delete(id);
    }

    this.edges = edgesData.map(e => ({
      ...e,
      sourceNode: this.nodes.get(e.source),
      targetNode: this.nodes.get(e.target),
    }));

    if (this.layoutMode === 'tier') {
      this.applyLayoutPositions();
    }

    this.render();
  }

  updateMetrics(nodesList, edgesList) {
    for (const raw of nodesList) {
      const node = this.nodes.get(raw.id);
      if (node) {
        node.metrics = raw.metrics;
        node.status = raw.status;
      }
    }

    const edgeMap = new Map(edgesList.map(e => [e.id, e]));
    for (const edge of this.edges) {
      const updated = edgeMap.get(edge.id);
      if (updated) {
        edge.requestRate = updated.requestRate;
        edge.latencyP50 = updated.latencyP50;
        edge.latencyP95 = updated.latencyP95;
        edge.latencyP99 = updated.latencyP99;
        edge.errorRate = updated.errorRate;
        edge.bytesPerSec = updated.bytesPerSec;
        edge.activeConnections = updated.activeConnections;
      }
    }

    this.updateHeaderStats();
    this.updateSVGAttributes();
    if (this.selectedNodeId) {
      this.updateInspectorMetrics();
    }
  }

  updateHeaderStats() {
    let totalRps = 0;
    let latSum = 0;
    let edgeCount = 0;
    let failingCount = 0;

    for (const edge of this.edges) {
      if (edge.requestRate > 0) {
        totalRps += edge.requestRate;
        latSum += edge.latencyP95;
        edgeCount++;
      }
    }

    for (const node of this.nodes.values()) {
      if (node.status === 'FAILING') failingCount++;
    }

    document.getElementById('statNodes').innerText = this.nodes.size;
    document.getElementById('statEdges').innerText = edgeCount;
    document.getElementById('statRps').innerText = `${totalRps.toFixed(1)} req/s`;
    document.getElementById('statLatency').innerText = edgeCount > 0 ? `${(latSum / edgeCount).toFixed(1)} ms` : '0.0 ms';

    const healthEl = document.getElementById('statHealth');
    if (failingCount > 0) {
      healthEl.innerText = `${failingCount} FAILING`;
      healthEl.className = 'stat-value status-badge-warn';
    } else {
      healthEl.innerText = 'HEALTHY';
      healthEl.className = 'stat-value status-badge-ok';
    }
  }

  // Pre-configured multi-tier architecture layout
  applyLayoutPositions() {
    if (this.layoutMode !== 'tier') return;

    const tiers = {
      ingress: 0,
      default_frontend: 1,
      default_gateway: 2,
      default_services: 3,
      platform: 4,
      storage: 4,
      external: 5,
    };

    const cx = this.width / 2;
    const cy = this.height / 2;
    const colSpacing = 220;

    const tierNodes = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };

    for (const node of this.nodes.values()) {
      let t = 3;
      if (node.namespace === 'ingress') t = 0;
      else if (node.name.includes('frontend')) t = 1;
      else if (node.name.includes('gateway')) t = 2;
      else if (node.namespace === 'platform') t = 4;
      else if (node.namespace === 'storage') t = 4;
      else if (node.namespace === 'external') t = 5;

      tierNodes[t].push(node);
    }

    Object.keys(tierNodes).forEach(t => {
      const list = tierNodes[t];
      const count = list.length;
      const x = cx + (parseInt(t, 10) - 2.5) * colSpacing;
      const rowSpacing = Math.min(100, (this.height * 0.7) / Math.max(1, count));
      const startY = cy - ((count - 1) * rowSpacing) / 2;

      list.forEach((node, idx) => {
        node.targetX = x;
        node.targetY = startY + idx * rowSpacing;
      });
    });
  }

  // Physics Force Simulation Loop
  startPhysicsLoop() {
    const step = () => {
      if (this.layoutMode === 'force') {
        const nodesList = Array.from(this.nodes.values());
        const k = 0.05; // spring constant
        const repulse = 3800; // electrostatic repulsion
        const centerGravity = 0.003;
        const cx = this.width / 2;
        const cy = this.height / 2;

        // 1. Center attraction
        for (const n of nodesList) {
          n.vx += (cx - n.x) * centerGravity;
          n.vy += (cy - n.y) * centerGravity;
        }

        // 2. Mutual node repulsion
        for (let i = 0; i < nodesList.length; i++) {
          for (let j = i + 1; j < nodesList.length; j++) {
            const a = nodesList[i];
            const b = nodesList[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < 400) {
              const force = repulse / (dist * dist);
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              a.vx -= fx;
              a.vy -= fy;
              b.vx += fx;
              b.vy += fy;
            }
          }
        }

        // 3. Link spring forces
        for (const edge of this.edges) {
          if (!edge.sourceNode || !edge.targetNode) continue;
          const a = edge.sourceNode;
          const b = edge.targetNode;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetDist = 180;
          const force = (dist - targetDist) * k;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }

        // 4. Update velocities and damping
        for (const n of nodesList) {
          n.vx *= 0.85; // damping
          n.vy *= 0.85;
          n.x += n.vx;
          n.y += n.vy;
        }
      } else if (this.layoutMode === 'tier') {
        // Smoothly interpolate towards assigned tier target
        for (const n of this.nodes.values()) {
          if (n.targetX !== undefined) {
            n.x += (n.targetX - n.x) * 0.12;
            n.y += (n.targetY - n.y) * 0.12;
          }
        }
      }

      this.updateSVGPositions();
      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  }

  // Particle Animation Loop (Canvas Layer)
  startParticleLoop() {
    let lastTime = performance.now();

    const loop = (now) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      this.ctx.clearRect(0, 0, this.width, this.height);

      // Save canvas state and apply pan/zoom transform
      this.ctx.save();
      this.ctx.translate(this.transform.x, this.transform.y);
      this.ctx.scale(this.transform.scale, this.transform.scale);

      // Periodically spawn particles based on edge requestRate
      if (this.isSimRunning) {
        for (const edge of this.edges) {
          if (edge.requestRate > 0.5 && (!edge.lastSpawn || now - edge.lastSpawn > (1000 / Math.min(20, edge.requestRate * 1.5)))) {
            edge.lastSpawn = now;
            const isFailing = edge.errorRate > 5 || edge.latencyP95 > 150 || this.affectedEdgeIds.has(edge.id);
            this.particles.push({
              edge,
              progress: 0,
              speed: Math.max(0.3, Math.min(1.8, 15 / (edge.latencyP95 || 5))),
              color: isFailing ? '#ef4444' : (edge.protocol === 'gRPC' ? '#818cf8' : '#38bdf8'),
              size: isFailing ? 3.5 : 2.5,
            });
          }
        }
      }

      // Update & render particles
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.progress += p.speed * dt;

        if (p.progress >= 1.0) {
          this.particles.splice(i, 1);
          continue;
        }

        const src = p.edge.sourceNode;
        const dst = p.edge.targetNode;
        if (!src || !dst) continue;

        // Quadratic curve interpolation
        const midX = (src.x + dst.x) / 2 + (dst.y - src.y) * 0.15;
        const midY = (src.y + dst.y) / 2 + (src.x - dst.x) * 0.15;

        const t = p.progress;
        const x = (1 - t) * (1 - t) * src.x + 2 * (1 - t) * t * midX + t * t * dst.x;
        const y = (1 - t) * (1 - t) * src.y + 2 * (1 - t) * t * midY + t * t * dst.y;

        this.ctx.beginPath();
        this.ctx.arc(x, y, p.size, 0, Math.PI * 2);
        this.ctx.fillStyle = p.color;
        this.ctx.shadowColor = p.color;
        this.ctx.shadowBlur = 6;
        this.ctx.fill();
        this.ctx.shadowBlur = 0;
      }

      this.ctx.restore();
      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  // Generate SVG DOM
  render() {
    this.renderHulls();
    this.renderEdges();
    this.renderNodes();
    this.updateHeaderStats();
  }

  renderHulls() {
    this.hullsLayer.innerHTML = '';
    const namespaces = ['ingress', 'default', 'platform', 'storage', 'external'];

    for (const ns of namespaces) {
      if (this.namespaceFilter !== 'all' && this.namespaceFilter !== ns) continue;

      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('id', `hull-group-${ns}`);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', `hull-group hull-group-${ns}`);
      path.setAttribute('id', `hull-path-${ns}`);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('class', 'hull-label');
      text.setAttribute('id', `hull-label-${ns}`);
      text.setAttribute('fill', '#64748b');
      text.textContent = `Namespace: ${ns}`;

      group.appendChild(path);
      group.appendChild(text);
      this.hullsLayer.appendChild(group);
    }
  }

  renderEdges() {
    this.edgesLayer.innerHTML = '';

    for (const edge of this.edges) {
      if (!this.isEdgeVisible(edge)) continue;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('id', `edge-${edge.id}`);
      path.setAttribute('class', 'edge-path');
      path.setAttribute('marker-end', 'url(#arrow-normal)');

      path.addEventListener('click', () => {
        if (edge.sourceNode) this.openInspector(edge.sourceNode);
      });

      this.edgesLayer.appendChild(path);
    }
  }

  renderNodes() {
    this.nodesLayer.innerHTML = '';

    for (const node of this.nodes.values()) {
      if (!this.isNodeVisible(node)) continue;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'node-group');
      g.setAttribute('id', `node-g-${node.id}`);

      // Halo for selection / blast radius
      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      halo.setAttribute('r', '26');
      halo.setAttribute('class', 'node-halo');
      halo.setAttribute('id', `halo-${node.id}`);
      halo.setAttribute('fill', 'url(#nodeGlow)');
      g.appendChild(halo);

      // Circle
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', '18');
      circle.setAttribute('class', `node-circle status-${node.status.toLowerCase()}`);
      circle.setAttribute('id', `circle-${node.id}`);
      g.appendChild(circle);

      // Node Icon
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      icon.setAttribute('class', 'node-icon-text');
      icon.setAttribute('text-anchor', 'middle');
      icon.setAttribute('dominant-baseline', 'central');
      icon.textContent = this.getNodeIcon(node.type);
      g.appendChild(icon);

      // Main Label
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('class', 'node-label');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('y', '30');
      label.textContent = node.name;
      g.appendChild(label);

      // Sublabel (req/s)
      const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      sub.setAttribute('class', 'node-sublabel');
      sub.setAttribute('text-anchor', 'middle');
      sub.setAttribute('y', '42');
      sub.setAttribute('id', `sub-${node.id}`);
      sub.textContent = `${node.metrics.requestRate} rps`;
      g.appendChild(sub);

      // Click to open Inspector
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openInspector(node);
      });

      this.nodesLayer.appendChild(g);
    }
  }

  getNodeIcon(type) {
    switch (type) {
      case 'INGRESS': return '🌐';
      case 'DATABASE': return '🗄️';
      case 'KAFKA': return '📨';
      case 'EXTERNAL': return '☁️';
      default: return '📦';
    }
  }

  isNodeVisible(node) {
    if (this.namespaceFilter !== 'all' && node.namespace !== this.namespaceFilter) return false;
    if (this.searchTerm && !node.name.toLowerCase().includes(this.searchTerm)) return false;
    return true;
  }

  isEdgeVisible(edge) {
    if (!this.isNodeVisible(edge.sourceNode) || !this.isNodeVisible(edge.targetNode)) return false;
    if (this.protocolFilter !== 'all' && edge.protocol !== this.protocolFilter) return false;
    return true;
  }

  // Update SVG transforms and paths during physics loop
  updateSVGPositions() {
    // 1. Update Nodes
    for (const node of this.nodes.values()) {
      const g = document.getElementById(`node-g-${node.id}`);
      if (g) {
        g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
      }
    }

    // 2. Update Edges
    for (const edge of this.edges) {
      const pathEl = document.getElementById(`edge-${edge.id}`);
      if (!pathEl || !edge.sourceNode || !edge.targetNode) continue;

      const src = edge.sourceNode;
      const dst = edge.targetNode;
      const midX = (src.x + dst.x) / 2 + (dst.y - src.y) * 0.15;
      const midY = (src.y + dst.y) / 2 + (src.x - dst.x) * 0.15;

      pathEl.setAttribute('d', `M ${src.x} ${src.y} Q ${midX} ${midY} ${dst.x} ${dst.y}`);
    }

    // 3. Update Namespace Convex Bounds
    const namespaces = ['ingress', 'default', 'platform', 'storage', 'external'];
    for (const ns of namespaces) {
      const pathEl = document.getElementById(`hull-path-${ns}`);
      const labelEl = document.getElementById(`hull-label-${ns}`);
      if (!pathEl) continue;

      const nsNodes = Array.from(this.nodes.values()).filter(n => n.namespace === ns && this.isNodeVisible(n));
      if (nsNodes.length === 0) {
        pathEl.setAttribute('d', '');
        if (labelEl) labelEl.textContent = '';
        continue;
      }

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of nsNodes) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }

      const pad = 45;
      minX -= pad; maxX += pad;
      minY -= pad; maxY += pad;

      const r = 16;
      const d = `M ${minX + r} ${minY} L ${maxX - r} ${minY} Q ${maxX} ${minY} ${maxX} ${minY + r} L ${maxX} ${maxY - r} Q ${maxX} ${maxY} ${maxX - r} ${maxY} L ${minX + r} ${maxY} Q ${minX} ${maxY} ${minX} ${maxY - r} L ${minX} ${minY + r} Q ${minX} ${minY} ${minX + r} ${minY} Z`;
      pathEl.setAttribute('d', d);

      if (labelEl) {
        labelEl.setAttribute('x', minX + 12);
        labelEl.setAttribute('y', minY + 20);
        labelEl.textContent = `Namespace: ${ns}`;
      }
    }
  }

  // Update dynamic metric classes on SVG elements
  updateSVGAttributes() {
    for (const node of this.nodes.values()) {
      const circle = document.getElementById(`circle-${node.id}`);
      if (circle) {
        circle.setAttribute('class', `node-circle status-${node.status.toLowerCase()}`);
      }
      const sub = document.getElementById(`sub-${node.id}`);
      if (sub) {
        sub.textContent = `${node.metrics.requestRate} rps`;
      }

      const halo = document.getElementById(`halo-${node.id}`);
      if (halo) {
        if (this.affectedNodeIds.has(node.id)) {
          halo.classList.add('blast-halo');
        } else {
          halo.classList.remove('blast-halo');
        }
      }
    }

    for (const edge of this.edges) {
      const pathEl = document.getElementById(`edge-${edge.id}`);
      if (pathEl) {
        const isFailing = edge.errorRate > 5 || edge.latencyP95 > 150;
        const isBlast = this.affectedEdgeIds.has(edge.id);

        if (isBlast) {
          pathEl.setAttribute('class', 'edge-path edge-blast-upstream');
          pathEl.setAttribute('marker-end', 'url(#arrow-blast)');
        } else if (isFailing) {
          pathEl.setAttribute('class', 'edge-path edge-failing');
          pathEl.setAttribute('marker-end', 'url(#arrow-failing)');
        } else {
          pathEl.setAttribute('class', 'edge-path');
          pathEl.setAttribute('marker-end', 'url(#arrow-normal)');
        }
      }
    }
  }

  // Open Service Inspector
  openInspector(node) {
    this.selectedNodeId = node.id;
    const drawer = document.getElementById('inspectorDrawer');
    drawer.classList.add('open');

    document.getElementById('drawerType').innerText = node.type;
    document.getElementById('drawerName').innerText = node.name;
    document.getElementById('drawerNs').innerText = `namespace: ${node.namespace}`;
    document.getElementById('metaKind').innerText = node.workloadKind;
    document.getElementById('metaIp').innerText = node.ip;
    document.getElementById('metaNetns').innerText = `402653${Math.floor(2000 + Math.random() * 8000)}`;

    this.updateInspectorMetrics();
    this.renderInspectorDependencies(node);

    // Reset blast result card
    document.getElementById('blastResultPanel').classList.add('hidden');
  }

  updateInspectorMetrics() {
    const node = this.nodes.get(this.selectedNodeId);
    if (!node) return;

    document.getElementById('metricRps').innerText = `${node.metrics.requestRate} req/s`;
    document.getElementById('metricP95').innerText = `${node.metrics.latencyP95} ms`;
    document.getElementById('metricErrors').innerText = `${node.metrics.errorRate}%`;
    document.getElementById('metricThroughput').innerText = `${Math.round(node.metrics.bytesPerSec / 1024)} KB/s`;

    const statusCard = document.getElementById('drawerStatusCard');
    const statusTitle = document.getElementById('drawerStatusTitle');
    const statusDesc = document.getElementById('drawerStatusDesc');

    if (node.status === 'FAILING') {
      statusCard.className = 'drawer-status-card failing';
      statusTitle.innerText = 'FAILING / HIGH ERROR RATE';
      statusDesc.innerText = 'Service is exceeding latency and error rate SLO limits';
    } else if (node.status === 'DEGRADED') {
      statusCard.className = 'drawer-status-card failing';
      statusTitle.innerText = 'DEGRADED';
      statusDesc.innerText = 'Elevated latency detected on one or more inbound flows';
    } else {
      statusCard.className = 'drawer-status-card';
      statusTitle.innerText = 'HEALTHY';
      statusDesc.innerText = 'Operating within defined latency and error SLOs';
    }
  }

  renderInspectorDependencies(node) {
    const inbound = this.edges.filter(e => e.target === node.id);
    const outbound = this.edges.filter(e => e.source === node.id);

    const inList = document.getElementById('inboundList');
    inList.innerHTML = '';
    if (inbound.length === 0) {
      inList.innerHTML = '<div class="empty-state">No incoming connections</div>';
    } else {
      for (const e of inbound) {
        const item = document.createElement('div');
        item.className = 'dep-item';
        item.innerHTML = `
          <span class="dep-name">${e.sourceNode ? e.sourceNode.name : e.source}</span>
          <span class="dep-proto">${e.protocol} • ${e.requestRate} rps</span>
        `;
        item.addEventListener('click', () => {
          if (e.sourceNode) this.openInspector(e.sourceNode);
        });
        inList.appendChild(item);
      }
    }

    const outList = document.getElementById('outboundList');
    outList.innerHTML = '';
    if (outbound.length === 0) {
      outList.innerHTML = '<div class="empty-state">No outgoing connections</div>';
    } else {
      for (const e of outbound) {
        const item = document.createElement('div');
        item.className = 'dep-item';
        item.innerHTML = `
          <span class="dep-name">${e.targetNode ? e.targetNode.name : e.target}</span>
          <span class="dep-proto">${e.protocol} • ${e.latencyP95}ms</span>
        `;
        item.addEventListener('click', () => {
          if (e.targetNode) this.openInspector(e.targetNode);
        });
        outList.appendChild(item);
      }
    }
  }

  closeInspector() {
    this.selectedNodeId = null;
    document.getElementById('inspectorDrawer').classList.remove('open');
  }

  // Analyze upstream blast radius using reverse graph traversal
  async runBlastRadiusAnalysis(nodeId) {
    try {
      const resp = await fetch(`/api/v1/services/${encodeURIComponent(nodeId)}/blast-radius`);
      const blast = await resp.json();

      this.blastRadiusNodeId = nodeId;
      this.affectedNodeIds = new Set(blast.affectedNodeIds);
      this.affectedEdgeIds = new Set();

      for (const p of blast.dependencyPaths) {
        for (const e of this.edges) {
          if (e.source === p.source && e.target === p.target) {
            this.affectedEdgeIds.add(e.id);
          }
        }
      }

      // Display results card in inspector
      const panel = document.getElementById('blastResultPanel');
      panel.classList.remove('hidden');

      const sevEl = document.getElementById('blastSeverity');
      sevEl.innerText = `${blast.impactSeverity} IMPACT`;
      document.getElementById('blastCount').innerText = `${blast.totalAffectedServices} Upstream Services Impacted`;

      const pathsList = document.getElementById('blastPathsList');
      pathsList.innerHTML = '';
      if (blast.affectedServices.length === 0) {
        pathsList.innerHTML = '<div class="empty-state">No upstream callers found. Isolated edge service.</div>';
      } else {
        for (const a of blast.affectedServices) {
          const row = document.createElement('div');
          row.className = 'blast-step';
          row.innerHTML = `<span class="blast-arrow">◀</span> <strong>${a.node ? a.node.name : a.nodeId}</strong> (${a.distance})`;
          pathsList.appendChild(row);
        }
      }

      this.updateSVGAttributes();
    } catch (err) {
      console.error('Blast radius calculation failed:', err);
    }
  }

  clearBlastRadius() {
    this.blastRadiusNodeId = null;
    this.affectedNodeIds.clear();
    this.affectedEdgeIds.clear();
    const panel = document.getElementById('blastResultPanel');
    if (panel) panel.classList.add('hidden');
    this.updateSVGAttributes();
  }

  // Time-travel historical replay
  async fetchHistory() {
    try {
      const resp = await fetch('/api/v1/topology/history?limit=30');
      const data = await resp.json();
      this.historicalSnapshots = data.snapshots || [];

      const slider = document.getElementById('timeSlider');
      if (this.historicalSnapshots.length > 0) {
        slider.max = this.historicalSnapshots.length - 1;
        slider.value = this.historicalSnapshots.length - 1;
        document.getElementById('timeStart').innerText = new Date(this.historicalSnapshots[0].timestamp).toLocaleTimeString();
        document.getElementById('timeEnd').innerText = new Date(this.historicalSnapshots[this.historicalSnapshots.length - 1].timestamp).toLocaleTimeString();
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  scrubToHistoryIndex(idx) {
    if (!this.historicalSnapshots || this.historicalSnapshots.length === 0) return;
    const isLatest = idx >= this.historicalSnapshots.length - 1;
    this.isLiveMode = isLatest;

    const snap = this.historicalSnapshots[idx];
    if (snap) {
      document.getElementById('timeCurrent').innerText = isLatest ? 'LIVE (NOW)' : new Date(snap.timestamp).toLocaleTimeString();
      document.getElementById('liveBadge').innerText = isLatest ? 'LIVE MODE' : 'TIME TRAVEL REPLAY';
      document.getElementById('liveBadge').style.color = isLatest ? 'var(--color-sky)' : 'var(--color-amber)';
      this.syncGraphData(snap.nodes, snap.edges);
    }
  }

  playHistory() {
    let curr = 0;
    const slider = document.getElementById('timeSlider');
    const btn = document.getElementById('btnPlayHistory');
    btn.innerText = '⏸';

    const interval = setInterval(() => {
      if (curr >= this.historicalSnapshots.length) {
        clearInterval(interval);
        btn.innerText = '▶';
        slider.value = this.historicalSnapshots.length - 1;
        this.scrubToHistoryIndex(this.historicalSnapshots.length - 1);
        return;
      }
      slider.value = curr;
      this.scrubToHistoryIndex(curr);
      curr++;
    }, 600);
  }
}

// Initialize on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.flowVisualizer = new FlowVisualizer();
});
