// FlowCartographer Topology Graph Engine
// Directed Attributed Graph with dynamic rate estimation, blast radius computation, and snapshotting

import crypto from 'node:crypto';

export class GraphEngine {
  constructor(persistenceStore) {
    this.store = persistenceStore;
    this.nodes = new Map(); // id -> Node
    this.edges = new Map(); // id -> Edge
    this.subscribers = new Set();
    this.anomalyActive = false;
    this.anomalyNodeId = null;

    // Sliding window buffer for edge stats (edgeId -> array of samples)
    this.edgeSamples = new Map();

    // Start background decay & snapshot interval
    this.decayTimer = setInterval(() => this.tick(), 1000);
    this.snapshotTimer = setInterval(() => this.captureSnapshot(), 5000);
  }

  generateNodeId(namespace, name) {
    return `${namespace || 'default'}/${name}`;
  }

  generateEdgeId(sourceId, targetId, protocol, port) {
    return `${sourceId}->${targetId}:${protocol || 'TCP'}:${port || 0}`;
  }

  upsertNode(data) {
    const id = data.id || this.generateNodeId(data.namespace, data.name);
    let node = this.nodes.get(id);

    if (!node) {
      node = {
        id,
        name: data.name,
        namespace: data.namespace || 'default',
        type: data.type || 'SERVICE', // SERVICE, POD, DATABASE, KAFKA, EXTERNAL, INGRESS
        workloadKind: data.workloadKind || 'Deployment',
        ip: data.ip || '10.244.0.1',
        status: 'HEALTHY', // HEALTHY, DEGRADED, FAILING
        metrics: {
          requestRate: 0,
          errorRate: 0,
          latencyP50: 1.0,
          latencyP95: 5.0,
          latencyP99: 12.0,
          bytesPerSec: 0,
        },
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      this.nodes.set(id, node);
      this.notifySubscribers({ type: 'NODE_ADDED', node });
    } else {
      node.lastSeen = new Date().toISOString();
      if (data.ip) node.ip = data.ip;
      if (data.workloadKind) node.workloadKind = data.workloadKind;
      if (data.type) node.type = data.type;
    }

    return node;
  }

  upsertEdge(sourceData, targetData, flowDetails) {
    const sourceNode = this.upsertNode(sourceData);
    const targetNode = this.upsertNode(targetData);

    const protocol = flowDetails.protocol || 'TCP';
    const port = flowDetails.port || 80;
    const edgeId = this.generateEdgeId(sourceNode.id, targetNode.id, protocol, port);

    let edge = this.edges.get(edgeId);
    const now = Date.now();

    if (!edge) {
      edge = {
        id: edgeId,
        source: sourceNode.id,
        target: targetNode.id,
        protocol,
        port,
        requestRate: 0,
        latencyP50: flowDetails.latencyMs || 2.0,
        latencyP95: (flowDetails.latencyMs || 2.0) * 2.5,
        latencyP99: (flowDetails.latencyMs || 2.0) * 4.0,
        errorRate: flowDetails.isError ? 100 : 0,
        bytesPerSec: flowDetails.bytes || 1024,
        activeConnections: 1,
        lastObserved: new Date().toISOString(),
      };
      this.edges.set(edgeId, edge);
      this.edgeSamples.set(edgeId, []);
      this.notifySubscribers({ type: 'EDGE_ADDED', edge });
    }

    // Record sample for sliding window
    let samples = this.edgeSamples.get(edgeId);
    if (!samples) {
      samples = [];
      this.edgeSamples.set(edgeId, samples);
    }

    samples.push({
      timestamp: now,
      latency: flowDetails.latencyMs || 2.0,
      bytes: flowDetails.bytes || 1024,
      isError: flowDetails.isError || false,
    });

    edge.lastObserved = new Date().toISOString();
    return edge;
  }

  // Ingest batch of events from eBPF Agent
  ingestBatch(batch) {
    if (!batch || !batch.events || !Array.isArray(batch.events)) {
      return { processed: 0 };
    }

    let processed = 0;
    for (const evt of batch.events) {
      if (!evt.source || !evt.dest) continue;

      const srcName = evt.source.service || evt.source.podName || evt.source.process || 'client';
      const dstName = evt.dest.service || evt.dest.podName || `svc-${evt.dest.ip}`;

      let srcType = 'SERVICE';
      if (srcName.includes('ingress')) srcType = 'INGRESS';
      if (evt.source.namespace === 'storage' || srcName.includes('db') || srcName.includes('postgres')) srcType = 'DATABASE';
      if (srcName.includes('kafka')) srcType = 'KAFKA';
      if (evt.source.namespace === 'external') srcType = 'EXTERNAL';

      let dstType = 'SERVICE';
      if (dstName.includes('ingress')) dstType = 'INGRESS';
      if (evt.dest.namespace === 'storage' || dstName.includes('db') || dstName.includes('postgres') || dstName.includes('redis')) dstType = 'DATABASE';
      if (dstName.includes('kafka')) dstType = 'KAFKA';
      if (evt.dest.namespace === 'external' || dstName.includes('ext-') || dstName.includes('stripe')) dstType = 'EXTERNAL';

      const latencyMs = evt.durationNs ? evt.durationNs / 1000000 : (1.5 + Math.random() * 4.0);
      const bytes = (evt.bytesSent || 0) + (evt.bytesRecv || 0) || (500 + Math.floor(Math.random() * 2000));

      this.upsertEdge(
        {
          name: srcName,
          namespace: evt.source.namespace || 'default',
          type: srcType,
          workloadKind: evt.source.workloadKind || 'Deployment',
          ip: evt.source.ip ? String(evt.source.ip) : '10.244.0.10',
        },
        {
          name: dstName,
          namespace: evt.dest.namespace || 'default',
          type: dstType,
          workloadKind: evt.dest.workloadKind || 'Deployment',
          ip: evt.dest.ip ? String(evt.dest.ip) : '10.244.0.20',
        },
        {
          protocol: evt.protocol || 'TCP',
          port: evt.dest.port || 80,
          latencyMs,
          bytes,
          isError: false,
        }
      );
      processed++;
    }

    return { processed };
  }

  // Periodic sliding-window metrics re-calculation
  tick() {
    const now = Date.now();
    const windowMs = 5000; // 5-second sliding window

    // Reset node metrics accumulator
    const nodeMetricAcc = new Map();
    for (const [nodeId] of this.nodes) {
      nodeMetricAcc.set(nodeId, {
        reqCount: 0,
        errCount: 0,
        bytes: 0,
        latencies: [],
      });
    }

    // Process each edge
    for (const [edgeId, edge] of this.edges) {
      let samples = this.edgeSamples.get(edgeId) || [];
      // Keep only samples within window
      samples = samples.filter(s => now - s.timestamp <= windowMs);
      this.edgeSamples.set(edgeId, samples);

      if (samples.length === 0) {
        // Natural decay when no recent traffic
        edge.requestRate = Math.max(0, edge.requestRate * 0.7);
        edge.bytesPerSec = Math.max(0, edge.bytesPerSec * 0.7);
        edge.activeConnections = edge.requestRate > 0.1 ? 1 : 0;
      } else {
        const durationSec = Math.min(5, Math.max(1, (now - samples[0].timestamp) / 1000));
        edge.requestRate = parseFloat((samples.length / durationSec).toFixed(1));

        let totalBytes = 0;
        let errCount = 0;
        const lats = [];

        for (const s of samples) {
          totalBytes += s.bytes;
          if (s.isError) errCount++;
          lats.push(s.latency);
        }

        edge.bytesPerSec = Math.round(totalBytes / durationSec);
        edge.errorRate = parseFloat(((errCount / samples.length) * 100).toFixed(1));

        lats.sort((a, b) => a - b);
        edge.latencyP50 = parseFloat(lats[Math.floor(lats.length * 0.5)].toFixed(2));
        edge.latencyP95 = parseFloat(lats[Math.floor(lats.length * 0.95)].toFixed(2));
        edge.latencyP99 = parseFloat(lats[Math.floor(lats.length * 0.99)].toFixed(2));
        edge.activeConnections = Math.max(1, Math.min(20, Math.ceil(edge.requestRate / 2)));
      }

      // If active anomaly on target node, spike latency and error rate
      if (this.anomalyActive && edge.target === this.anomalyNodeId) {
        edge.latencyP50 = Math.max(edge.latencyP50, 185.4);
        edge.latencyP95 = Math.max(edge.latencyP95, 420.8);
        edge.latencyP99 = Math.max(edge.latencyP99, 980.2);
        edge.errorRate = Math.max(edge.errorRate, 24.5);
      }

      // Aggregate into target node metrics
      const targetAcc = nodeMetricAcc.get(edge.target);
      if (targetAcc) {
        targetAcc.reqCount += edge.requestRate;
        targetAcc.bytes += edge.bytesPerSec;
        if (edge.errorRate > 0) targetAcc.errCount += (edge.requestRate * edge.errorRate) / 100;
        targetAcc.latencies.push(edge.latencyP95);
      }
    }

    // Update node health and aggregate metrics
    for (const [nodeId, node] of this.nodes) {
      const acc = nodeMetricAcc.get(nodeId);
      if (!acc || acc.reqCount === 0) {
        node.metrics.requestRate = 0;
        node.metrics.errorRate = 0;
        node.metrics.bytesPerSec = 0;
        node.status = 'HEALTHY';
      } else {
        node.metrics.requestRate = parseFloat(acc.reqCount.toFixed(1));
        node.metrics.bytesPerSec = acc.bytes;
        node.metrics.errorRate = acc.reqCount > 0 ? parseFloat(((acc.errCount / acc.reqCount) * 100).toFixed(1)) : 0;
        acc.latencies.sort((a, b) => a - b);
        node.metrics.latencyP95 = acc.latencies.length > 0 ? parseFloat(acc.latencies[Math.floor(acc.latencies.length * 0.95)].toFixed(2)) : 5.0;

        if (this.anomalyActive && nodeId === this.anomalyNodeId) {
          node.status = 'FAILING';
          node.metrics.errorRate = 24.5;
          node.metrics.latencyP95 = 420.8;
        } else if (node.metrics.errorRate > 5.0 || node.metrics.latencyP95 > 150) {
          node.status = 'FAILING';
        } else if (node.metrics.errorRate > 1.0 || node.metrics.latencyP95 > 50) {
          node.status = 'DEGRADED';
        } else {
          node.status = 'HEALTHY';
        }
      }
    }

    this.notifySubscribers({
      type: 'METRICS_TICK',
      timestamp: new Date().toISOString(),
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    });
  }

  // Calculate transitive blast radius for a failing or degraded node
  computeBlastRadius(rootCauseNodeId) {
    if (!this.nodes.has(rootCauseNodeId)) {
      return {
        rootCauseNodeId,
        affectedNodeIds: [],
        impactSeverity: 'NONE',
        totalAffectedServices: 0,
        dependencyPaths: [],
      };
    }

    // Build reverse adjacency list: target -> array of incoming edges (sources)
    const reverseAdj = new Map();
    for (const edge of this.edges.values()) {
      if (!reverseAdj.has(edge.target)) {
        reverseAdj.set(edge.target, []);
      }
      reverseAdj.get(edge.target).push(edge);
    }

    // BFS to find all upstream callers affected
    const visited = new Set([rootCauseNodeId]);
    const queue = [{ id: rootCauseNodeId, depth: 0, path: [rootCauseNodeId] }];
    const affected = [];
    const paths = [];

    while (queue.length > 0) {
      const { id, depth, path } = queue.shift();
      const incomingEdges = reverseAdj.get(id) || [];

      for (const edge of incomingEdges) {
        const callerId = edge.source;
        paths.push({
          source: callerId,
          target: id,
          depth: depth + 1,
          protocol: edge.protocol,
          latency: edge.latencyP95,
        });

        if (!visited.has(callerId)) {
          visited.add(callerId);
          affected.push({
            nodeId: callerId,
            depth: depth + 1,
            distance: `${depth + 1} hops upstream`,
            node: this.nodes.get(callerId),
          });
          queue.push({
            id: callerId,
            depth: depth + 1,
            path: [...path, callerId],
          });
        }
      }
    }

    // Determine impact severity
    let severity = 'LOW';
    const totalServices = this.nodes.size || 1;
    const impactRatio = affected.length / totalServices;

    const hasIngress = affected.some(a => a.node && (a.node.type === 'INGRESS' || a.node.name.includes('frontend') || a.node.name.includes('gateway')));

    if (hasIngress || impactRatio > 0.4) {
      severity = 'CRITICAL';
    } else if (impactRatio > 0.2 || affected.length >= 2) {
      severity = 'HIGH';
    } else if (affected.length > 0) {
      severity = 'MEDIUM';
    }

    return {
      rootCauseNodeId,
      rootCauseNode: this.nodes.get(rootCauseNodeId),
      affectedNodeIds: affected.map(a => a.nodeId),
      affectedServices: affected,
      impactSeverity: severity,
      totalAffectedServices: affected.length,
      dependencyPaths: paths,
    };
  }

  // Toggle simulated anomaly (e.g. payment-gateway outage)
  toggleAnomaly(serviceName = 'payment-service') {
    let targetNode = null;
    for (const [id, node] of this.nodes) {
      if (node.name === serviceName || node.name.includes(serviceName)) {
        targetNode = node;
        break;
      }
    }

    if (!targetNode && this.nodes.size > 0) {
      targetNode = Array.from(this.nodes.values())[Math.floor(this.nodes.size / 2)];
    }

    if (!targetNode) return { active: false, message: 'No nodes present in graph' };

    this.anomalyActive = !this.anomalyActive;
    this.anomalyNodeId = this.anomalyActive ? targetNode.id : null;

    if (this.anomalyActive) {
      this.store.recordAnomaly(
        targetNode.id,
        'LATENCY_AND_ERROR_SPIKE',
        `Simulated downstream failure on ${targetNode.name}: 24.5% error rate, 420ms P95 latency`
      );
    }

    const blast = this.computeBlastRadius(targetNode.id);

    this.notifySubscribers({
      type: 'ANOMALY_STATUS',
      active: this.anomalyActive,
      targetNode: targetNode.id,
      blastRadius: blast,
    });

    return {
      active: this.anomalyActive,
      targetNodeId: targetNode.id,
      targetNodeName: targetNode.name,
      blastRadius: blast,
    };
  }

  // Capture periodic snapshot to persistent SQLite store
  captureSnapshot() {
    if (this.nodes.size === 0) return;
    const ts = new Date().toISOString();
    const nodesList = Array.from(this.nodes.values());
    const edgesList = Array.from(this.edges.values());
    this.store.saveSnapshot(ts, nodesList, edgesList);

    // Also persist edge metrics
    for (const edge of edgesList) {
      if (edge.requestRate > 0) {
        this.store.recordEdgeMetrics(ts, edge);
      }
    }
  }

  // Export current graph representation
  getTopology(namespaceFilter = null) {
    let nodesList = Array.from(this.nodes.values());
    let edgesList = Array.from(this.edges.values());

    if (namespaceFilter && namespaceFilter !== 'all') {
      const allowedNodeIds = new Set(
        nodesList.filter(n => n.namespace === namespaceFilter).map(n => n.id)
      );
      nodesList = nodesList.filter(n => allowedNodeIds.has(n.id));
      edgesList = edgesList.filter(e => allowedNodeIds.has(e.source) && allowedNodeIds.has(e.target));
    }

    return {
      timestamp: new Date().toISOString(),
      nodeCount: nodesList.length,
      edgeCount: edgesList.length,
      nodes: nodesList,
      edges: edgesList,
      anomalyActive: this.anomalyActive,
      anomalyNodeId: this.anomalyNodeId,
    };
  }

  // Event stream subscription (SSE/WS)
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  notifySubscribers(data) {
    for (const cb of this.subscribers) {
      try {
        cb(data);
      } catch (err) {
        // Ignore dead listener
      }
    }
  }
}
