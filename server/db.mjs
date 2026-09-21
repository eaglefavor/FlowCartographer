// FlowCartographer Persistent Storage Layer
// Primary backend: Node 22 native SQLite engine (node:sqlite) — zero-dependency persistence.
// Fallback backend: in-process memory store.
//
// The fallback is used automatically when:
//   1. `node:sqlite` is not available on the running Node build (added in v22.5.0), or
//   2. the target path is not writable (e.g. the read-only `/var/task` filesystem of a
//      serverless platform such as Vercel), or the path is `:memory:`.
// The public API is identical for both backends, so callers never need to care.

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require_('node:sqlite'));
} catch {
  DatabaseSync = null;
}

export function isSqliteAvailable() {
  return DatabaseSync !== null;
}

const SCHEMA = `
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        nodes_json TEXT NOT NULL,
        edges_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edge_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        protocol TEXT NOT NULL,
        request_rate REAL NOT NULL,
        latency_p50 REAL NOT NULL,
        latency_p95 REAL NOT NULL,
        latency_p99 REAL NOT NULL,
        error_rate REAL NOT NULL,
        bytes_per_sec REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS anomalies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        service_id TEXT NOT NULL,
        anomaly_type TEXT NOT NULL,
        message TEXT NOT NULL,
        resolved INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_edge_metrics_ts ON edge_metrics(timestamp);
    `;

// ---------------------------------------------------------------------------
// Backend 1: node:sqlite
// ---------------------------------------------------------------------------
class SqliteBackend {
  constructor(db) {
    this.kind = 'sqlite';
    this.db = db;
    this.db.exec(SCHEMA);
  }

  saveSnapshot(timestamp, nodes, edges) {
    const insert = this.db.prepare(`
      INSERT INTO snapshots (timestamp, node_count, edge_count, nodes_json, edges_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    return insert.run(
      timestamp,
      nodes.length,
      edges.length,
      JSON.stringify(nodes),
      JSON.stringify(edges)
    );
  }

  getSnapshots(limit = 20) {
    const query = this.db.prepare(`
      SELECT id, timestamp, node_count, edge_count, nodes_json, edges_json
      FROM snapshots
      ORDER BY id DESC
      LIMIT ?
    `);
    const rows = query.all(limit);
    return rows.reverse().map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      nodeCount: r.node_count,
      edgeCount: r.edge_count,
      nodes: JSON.parse(r.nodes_json),
      edges: JSON.parse(r.edges_json)
    }));
  }

  getSnapshotByTimestamp(timestamp) {
    const query = this.db.prepare(`
      SELECT * FROM snapshots
      ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', ?)) ASC
      LIMIT 1
    `);
    const row = query.get(timestamp);
    if (!row) return null;
    return {
      id: row.id,
      timestamp: row.timestamp,
      nodeCount: row.node_count,
      edgeCount: row.edge_count,
      nodes: JSON.parse(row.nodes_json),
      edges: JSON.parse(row.edges_json)
    };
  }

  recordEdgeMetrics(timestamp, edge) {
    const insert = this.db.prepare(`
      INSERT INTO edge_metrics (timestamp, source_id, target_id, protocol, request_rate, latency_p50, latency_p95, latency_p99, error_rate, bytes_per_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return insert.run(
      timestamp,
      edge.source,
      edge.target,
      edge.protocol,
      edge.requestRate || 0,
      edge.latencyP50 || 0,
      edge.latencyP95 || 0,
      edge.latencyP99 || 0,
      edge.errorRate || 0,
      edge.bytesPerSec || 0
    );
  }

  recordAnomaly(serviceId, type, message) {
    const insert = this.db.prepare(`
      INSERT INTO anomalies (timestamp, service_id, anomaly_type, message, resolved)
      VALUES (?, ?, ?, ?, 0)
    `);
    return insert.run(new Date().toISOString(), serviceId, type, message);
  }

  getActiveAnomalies() {
    const query = this.db.prepare(`
      SELECT * FROM anomalies WHERE resolved = 0 ORDER BY id DESC LIMIT 50
    `);
    return query.all();
  }

  close() {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Backend 2: in-process memory (serverless / no node:sqlite fallback)
// Bounded so a long-lived instance cannot grow without limit.
// ---------------------------------------------------------------------------
const MAX_MEMORY_ROWS = 2000;

class MemoryBackend {
  constructor() {
    this.kind = 'memory';
    this.snapshots = [];
    this.edgeMetrics = [];
    this.anomalies = [];
    this.nextId = 1;
  }

  saveSnapshot(timestamp, nodes, edges) {
    const row = {
      id: this.nextId++,
      timestamp,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes: nodes.map(n => ({ ...n })),
      edges: edges.map(e => ({ ...e }))
    };
    this.snapshots.push(row);
    if (this.snapshots.length > MAX_MEMORY_ROWS) {
      this.snapshots.splice(0, this.snapshots.length - MAX_MEMORY_ROWS);
    }
    return { changes: 1 };
  }

  getSnapshots(limit = 20) {
    return this.snapshots.slice(-limit).map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      nodeCount: r.nodeCount,
      edgeCount: r.edgeCount,
      nodes: r.nodes,
      edges: r.edges
    }));
  }

  getSnapshotByTimestamp(timestamp) {
    if (this.snapshots.length === 0) return null;
    const target = Date.parse(timestamp);
    let best = null;
    let bestDelta = Infinity;
    for (const row of this.snapshots) {
      const delta = Math.abs(Date.parse(row.timestamp) - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = row;
      }
    }
    if (!best) return null;
    return {
      id: best.id,
      timestamp: best.timestamp,
      nodeCount: best.nodeCount,
      edgeCount: best.edgeCount,
      nodes: best.nodes,
      edges: best.edges
    };
  }

  recordEdgeMetrics(timestamp, edge) {
    this.edgeMetrics.push({
      id: this.nextId++,
      timestamp,
      source_id: edge.source,
      target_id: edge.target,
      protocol: edge.protocol,
      request_rate: edge.requestRate || 0,
      latency_p50: edge.latencyP50 || 0,
      latency_p95: edge.latencyP95 || 0,
      latency_p99: edge.latencyP99 || 0,
      error_rate: edge.errorRate || 0,
      bytes_per_sec: edge.bytesPerSec || 0
    });
    if (this.edgeMetrics.length > MAX_MEMORY_ROWS) {
      this.edgeMetrics.splice(0, this.edgeMetrics.length - MAX_MEMORY_ROWS);
    }
    return { changes: 1 };
  }

  recordAnomaly(serviceId, type, message) {
    this.anomalies.push({
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      service_id: serviceId,
      anomaly_type: type,
      message,
      resolved: 0
    });
    return { changes: 1 };
  }

  getActiveAnomalies() {
    return this.anomalies.filter(a => a.resolved === 0).slice(-50).reverse();
  }

  close() {
    this.snapshots = [];
    this.edgeMetrics = [];
    this.anomalies = [];
  }
}

// ---------------------------------------------------------------------------
// Public façade
// ---------------------------------------------------------------------------
function openBackend(dbPath) {
  if (DatabaseSync && dbPath !== ':memory:') {
    try {
      const dir = path.dirname(dbPath);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      return new SqliteBackend(new DatabaseSync(dbPath));
    } catch (err) {
      console.warn(
        `[FlowCartographer] SQLite backend unavailable at "${dbPath}" (${err.code || err.message}). ` +
        `Falling back to in-memory persistence for this process.`
      );
    }
  } else if (!DatabaseSync) {
    console.warn(
      '[FlowCartographer] node:sqlite is not available on this runtime; ' +
      'falling back to in-memory persistence for this process.'
    );
  }
  return new MemoryBackend();
}

export class PersistenceStore {
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    this.backend = openBackend(dbPath);
    this.kind = this.backend.kind;
  }

  saveSnapshot(timestamp, nodes, edges) {
    return this.backend.saveSnapshot(timestamp, nodes, edges);
  }

  getSnapshots(limit = 20) {
    return this.backend.getSnapshots(limit);
  }

  getSnapshotByTimestamp(timestamp) {
    return this.backend.getSnapshotByTimestamp(timestamp);
  }

  recordEdgeMetrics(timestamp, edge) {
    return this.backend.recordEdgeMetrics(timestamp, edge);
  }

  recordAnomaly(serviceId, type, message) {
    return this.backend.recordAnomaly(serviceId, type, message);
  }

  getActiveAnomalies() {
    return this.backend.getActiveAnomalies();
  }

  close() {
    return this.backend.close();
  }
}

export { MemoryBackend, SqliteBackend };
