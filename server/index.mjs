// FlowCartographer Aggregator & Topology Engine Server
// Native Node.js 22 ES Module server (zero external npm dependencies required)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersistenceStore } from './db.mjs';
import { GraphEngine } from './graph_engine.mjs';
import { ClusterSimulator } from './simulator.mjs';
import { handleGraphQLQuery } from './graphql_handler.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

// Initialize Storage, Graph Engine, and Simulator
const dbPath = path.resolve(__dirname, '../data/flowcartographer.sqlite');
const store = new PersistenceStore(dbPath);
const graphEngine = new GraphEngine(store);
const simulator = new ClusterSimulator(graphEngine);

// Start live simulation out of the box
simulator.start();

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Ingestion Endpoint for eBPF Agents: POST /api/v1/events
  if (method === 'POST' && pathname === '/api/v1/events') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const result = graphEngine.ingestBatch(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', processed: result.processed }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload', details: err.message }));
      }
    });
    return;
  }

  // 2. Real-Time Topology Snapshot: GET /api/v1/topology
  if (method === 'GET' && pathname === '/api/v1/topology') {
    const ns = url.searchParams.get('namespace');
    const data = graphEngine.getTopology(ns);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // 3. Historical Snapshots: GET /api/v1/topology/history
  if (method === 'GET' && pathname === '/api/v1/topology/history') {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const snapshots = store.getSnapshots(limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: snapshots.length, snapshots }));
    return;
  }

  // 4. Services List: GET /api/v1/services
  if (method === 'GET' && pathname === '/api/v1/services') {
    const services = Array.from(graphEngine.nodes.values());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: services.length, services }));
    return;
  }

  // 5. Blast Radius Calculation: GET /api/v1/services/:id/blast-radius
  if (method === 'GET' && pathname.startsWith('/api/v1/services/') && pathname.endsWith('/blast-radius')) {
    const parts = pathname.split('/');
    // format: /api/v1/services/:id/blast-radius -> id at index 4 (or decode URI)
    const encodedId = parts.slice(4, -1).join('/');
    const serviceId = decodeURIComponent(encodedId);
    const result = graphEngine.computeBlastRadius(serviceId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 6. Toggle Simulated Outage / Anomaly: POST /api/v1/simulate/anomaly
  if (method === 'POST' && pathname === '/api/v1/simulate/anomaly') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let target = 'payment-service';
      try {
        if (body) {
          const parsed = JSON.parse(body);
          if (parsed.target) target = parsed.target;
        }
      } catch (e) {}
      const resData = graphEngine.toggleAnomaly(target);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resData));
    });
    return;
  }

  // 7. Toggle Simulator State: POST /api/v1/simulate/toggle
  if (method === 'POST' && pathname === '/api/v1/simulate/toggle') {
    if (simulator.running) {
      simulator.stop();
    } else {
      simulator.start();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: simulator.running }));
    return;
  }

  // 8. Prometheus Metrics Exporter: GET /metrics
  if (method === 'GET' && pathname === '/metrics') {
    const topology = graphEngine.getTopology();
    let prometheusText = `# HELP flowcartographer_nodes_total Total number of observed service nodes\n`;
    prometheusText += `# TYPE flowcartographer_nodes_total gauge\n`;
    prometheusText += `flowcartographer_nodes_total ${topology.nodeCount}\n\n`;

    prometheusText += `# HELP flowcartographer_edges_total Total number of active dependency edges\n`;
    prometheusText += `# TYPE flowcartographer_edges_total gauge\n`;
    prometheusText += `flowcartographer_edges_total ${topology.edgeCount}\n\n`;

    prometheusText += `# HELP flowcartographer_requests_per_sec Instantaneous requests per second on edge\n`;
    prometheusText += `# TYPE flowcartographer_requests_per_sec gauge\n`;
    for (const edge of topology.edges) {
      prometheusText += `flowcartographer_requests_per_sec{source="${edge.source}",target="${edge.target}",protocol="${edge.protocol}"} ${edge.requestRate}\n`;
    }

    prometheusText += `\n# HELP flowcartographer_edge_latency_p95_ms P95 round trip latency in milliseconds\n`;
    prometheusText += `# TYPE flowcartographer_edge_latency_p95_ms gauge\n`;
    for (const edge of topology.edges) {
      prometheusText += `flowcartographer_edge_latency_p95_ms{source="${edge.source}",target="${edge.target}",protocol="${edge.protocol}"} ${edge.latencyP95}\n`;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(prometheusText);
    return;
  }

  // 9. GraphQL API: POST /graphql
  if (method === 'POST' && pathname === '/graphql') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { query, variables } = JSON.parse(body);
        const result = handleGraphQLQuery(query, variables, graphEngine, store);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: err.message }] }));
      }
    });
    return;
  }

  // 10. Server-Sent Events (SSE) Live Stream: GET /api/v1/stream
  if (method === 'GET' && pathname === '/api/v1/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() })}\n\n`);

    // Send initial snapshot
    const initial = graphEngine.getTopology();
    res.write(`data: ${JSON.stringify({ type: 'SNAPSHOT', data: initial })}\n\n`);

    const unsubscribe = graphEngine.subscribe(msg => {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
    });
    return;
  }

  // 11. Static File Serving (Web UI)
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`FlowCartographer Aggregator & Topology Engine v1.0.0`);
  console.log(`Kernel-Level eBPF Service Map Generator`);
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Web Dashboard:       http://localhost:${PORT}`);
  console.log(`Topology REST API:   http://localhost:${PORT}/api/v1/topology`);
  console.log(`SSE Live Stream:     http://localhost:${PORT}/api/v1/stream`);
  console.log(`Prometheus Metrics:  http://localhost:${PORT}/metrics`);
  console.log(`GraphQL Endpoint:    http://localhost:${PORT}/graphql`);
  console.log(`=======================================================`);
});
