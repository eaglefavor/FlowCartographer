// FlowCartographer Aggregator & Topology Engine — application core
//
// This module owns the long-lived in-memory topology graph plus the HTTP request
// handler. It is deliberately free of any listening socket so the exact same code
// can be served by:
//   * `server/index.mjs`  — a plain `node:http` server (local dev, Docker, VM)
//   * `api/**.mjs`        — Vercel (or any Node serverless runtime) functions
//
// Zero external npm dependencies: everything below uses Node 22 built-ins.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PersistenceStore } from './db.mjs';
import { GraphEngine } from './graph_engine.mjs';
import { ClusterSimulator } from './simulator.mjs';
import { handleGraphQLQuery } from './graphql_handler.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PUBLIC_DIR = path.resolve(__dirname, '../public');

/**
 * Where the SQLite file should live.
 * Serverless filesystems are read-only (Vercel mounts the bundle at /var/task) and
 * ephemeral, so persistence is disabled there unless DATABASE_PATH says otherwise.
 */
export function resolveDbPath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (process.env.VERCEL) return ':memory:';
  return path.resolve(__dirname, '../data/flowcartographer.sqlite');
}

export function createApp({ dbPath = resolveDbPath(), startSimulator = true } = {}) {
  const store = new PersistenceStore(dbPath);
  const graphEngine = new GraphEngine(store);
  const simulator = new ClusterSimulator(graphEngine);

  if (startSimulator) simulator.start();

  return { store, graphEngine, simulator, dbPath, persistence: store.kind };
}

let appInstance = null;

/** Lazily-built process-wide singleton (one graph per warm instance). */
export function getApp() {
  if (!appInstance) {
    appInstance = createApp();
    console.log(
      `[FlowCartographer] Aggregator ready (persistence=${appInstance.persistence}, ` +
      `nodes=${appInstance.graphEngine.nodes.size})`
    );
  }
  return appInstance;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Vercel rewrites `/graphql` -> `/api/graphql` and `/metrics` -> `/api/metrics`, so the
 * function sees the rewritten path. Map those back to the canonical API surface so the
 * same handler serves both the standalone server and the serverless deployment.
 */
function canonicalPathname(pathname) {
  if (pathname === '/api/graphql') return '/graphql';
  if (pathname === '/api/metrics') return '/metrics';
  return pathname;
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createHandler(app = getApp()) {
  const { store, graphEngine, simulator } = app;

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = canonicalPathname(url.pathname);
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
      try {
        const payload = JSON.parse(await readBody(req));
        const result = graphEngine.ingestBatch(payload);
        sendJson(res, 200, { status: 'ok', processed: result.processed });
      } catch (err) {
        sendJson(res, 400, { error: 'Invalid JSON payload', details: err.message });
      }
      return;
    }

    // 2. Real-Time Topology Snapshot: GET /api/v1/topology
    if (method === 'GET' && pathname === '/api/v1/topology') {
      const ns = url.searchParams.get('namespace');
      sendJson(res, 200, graphEngine.getTopology(ns));
      return;
    }

    // 3. Historical Snapshots: GET /api/v1/topology/history
    if (method === 'GET' && pathname === '/api/v1/topology/history') {
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const snapshots = store.getSnapshots(limit);
      sendJson(res, 200, { count: snapshots.length, snapshots });
      return;
    }

    // 4. Services List: GET /api/v1/services
    if (method === 'GET' && pathname === '/api/v1/services') {
      const services = Array.from(graphEngine.nodes.values());
      sendJson(res, 200, { count: services.length, services });
      return;
    }

    // 5. Blast Radius Calculation: GET /api/v1/services/:id/blast-radius
    if (method === 'GET' && pathname.startsWith('/api/v1/services/') && pathname.endsWith('/blast-radius')) {
      const parts = pathname.split('/');
      // format: /api/v1/services/:id/blast-radius -> id at index 4 (or decode URI)
      const encodedId = parts.slice(4, -1).join('/');
      const serviceId = decodeURIComponent(encodedId);
      sendJson(res, 200, graphEngine.computeBlastRadius(serviceId));
      return;
    }

    // 6. Toggle Simulated Outage / Anomaly: POST /api/v1/simulate/anomaly
    if (method === 'POST' && pathname === '/api/v1/simulate/anomaly') {
      let target = 'payment-service';
      try {
        const body = await readBody(req);
        if (body) {
          const parsed = JSON.parse(body);
          if (parsed.target) target = parsed.target;
        }
      } catch (e) {
        /* keep the default target */
      }
      sendJson(res, 200, graphEngine.toggleAnomaly(target));
      return;
    }

    // 7. Toggle Simulator State: POST /api/v1/simulate/toggle
    if (method === 'POST' && pathname === '/api/v1/simulate/toggle') {
      if (simulator.running) {
        simulator.stop();
      } else {
        simulator.start();
      }
      sendJson(res, 200, { running: simulator.running });
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
      try {
        const { query, variables } = JSON.parse(await readBody(req));
        sendJson(res, 200, handleGraphQLQuery(query, variables, graphEngine, store));
      } catch (err) {
        sendJson(res, 400, { errors: [{ message: err.message }] });
      }
      return;
    }

    // 10. Server-Sent Events (SSE) Live Stream: GET /api/v1/stream
    if (method === 'GET' && pathname === '/api/v1/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() })}\n\n`);

      // Send initial snapshot
      const initial = graphEngine.getTopology();
      res.write(`data: ${JSON.stringify({ type: 'SNAPSHOT', data: initial })}\n\n`);

      const unsubscribe = graphEngine.subscribe(msg => {
        try {
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
        } catch {
          /* socket already gone; cleaned up by the close handler below */
        }
      });

      // Keep proxies (and the Vercel edge) from idling the connection out.
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    // 11. Static File Serving (Web UI)
    // On a static-first platform (Vercel) the files under /public are served by the CDN
    // and this branch is only a fallback for the standalone server.
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  };
}
