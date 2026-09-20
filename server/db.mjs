// FlowCartographer Persistent Storage Layer
// Uses Node 22 native SQLite engine for zero-dependency high-performance persistence

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export class PersistenceStore {
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
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
    `);
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
