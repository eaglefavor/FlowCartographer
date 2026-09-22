// Deployment verification suite for the Vercel (serverless) entrypoints.
//
// This exercises the exact modules Vercel packages into functions — `api/v1/[...path].mjs`,
// `api/graphql.mjs` and `api/metrics.mjs` — over real HTTP sockets, with the process
// environment set up the way Vercel sets it up (VERCEL=1, read-only bundle filesystem).

import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set before the function modules are imported: the aggregator is built at
// module scope (one graph per warm instance), exactly like a real cold start.
process.env.VERCEL = '1';

console.log('--- Running FlowCartographer Vercel Entrypoint Suite ---');

const { getApp } = await import('../server/app.mjs');
const { PersistenceStore } = await import('../server/db.mjs');

// Test 1: serverless persistence degrades to the in-memory backend
console.log('Test 1: Serverless storage fallback...');
assert.strictEqual(getApp().persistence, 'memory', 'VERCEL=1 must select the in-memory backend');
assert.strictEqual(getApp().dbPath, ':memory:');
// Use a regular file where a directory is expected: mkdir fails with ENOTDIR on every
// platform, which stands in for the read-only /var/task filesystem on Vercel.
const blocker = path.join(os.tmpdir(), `fc-blocker-${process.pid}`);
fs.writeFileSync(blocker, 'not a directory');
const unwritable = new PersistenceStore(path.join(blocker, 'fc.sqlite'));
assert.strictEqual(unwritable.kind, 'memory', 'an unwritable path must fall back to memory');
unwritable.saveSnapshot(new Date().toISOString(), [{ id: 'n' }], []);
assert.strictEqual(unwritable.getSnapshots(5).length, 1);
console.log('✔ Test 1 Passed: read-only filesystem falls back to in-memory persistence');

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}

// Test 2: the /api/v1/* catch-all function
console.log('Test 2: /api/v1/* catch-all function...');
const apiV1 = (await import('../api/v1/[...path].mjs')).default;
assert.strictEqual(typeof apiV1, 'function', 'function must export a default handler');
const v1 = await serve(apiV1);

const topologyRes = await fetch(`${v1.base}/api/v1/topology`);
assert.strictEqual(topologyRes.status, 200);
const topology = await topologyRes.json();
assert.ok(topology.nodeCount >= 15, `expected a warmed-up graph, got ${topology.nodeCount} nodes`);
assert.ok(topology.edgeCount >= 10, `expected edges from the simulator warmup, got ${topology.edgeCount}`);

const servicesRes = await fetch(`${v1.base}/api/v1/services`);
assert.strictEqual((await servicesRes.json()).count, topology.nodeCount);

const blastRes = await fetch(`${v1.base}/api/v1/services/${encodeURIComponent('default/payment-service')}/blast-radius`);
assert.strictEqual(blastRes.status, 200);
const blast = await blastRes.json();
assert.strictEqual(blast.rootCauseNodeId, 'default/payment-service');

const historyRes = await fetch(`${v1.base}/api/v1/topology/history?limit=5`);
assert.strictEqual(historyRes.status, 200);
assert.ok(Array.isArray((await historyRes.json()).snapshots));

const ingestRes = await fetch(`${v1.base}/api/v1/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nodeName: 'worker-1',
    events: [{
      type: 'CONNECT',
      protocol: 'HTTP',
      source: { service: 'edge-proxy', namespace: 'default', ip: '10.244.9.1', port: 40000 },
      dest: { service: 'api-gateway', namespace: 'default', ip: '10.244.1.20', port: 8080 },
      durationNs: 1200000,
      bytesSent: 512,
      bytesRecv: 2048,
    }],
  }),
});
assert.deepStrictEqual(await ingestRes.json(), { status: 'ok', processed: 1 });

const anomalyRes = await fetch(`${v1.base}/api/v1/simulate/anomaly`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'payment-service' }),
});
assert.strictEqual((await anomalyRes.json()).active, true);
// restore state for the remaining assertions
await fetch(`${v1.base}/api/v1/simulate/anomaly`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'payment-service' }),
});
console.log('✔ Test 2 Passed: catch-all function serves the whole /api/v1 surface');

// Test 3: SSE stream function (used by the dashboard when the platform allows it)
console.log('Test 3: SSE stream function...');
const controller = new AbortController();
const sseRes = await fetch(`${v1.base}/api/v1/stream`, { signal: controller.signal });
assert.strictEqual(sseRes.status, 200);
assert.match(sseRes.headers.get('content-type'), /text\/event-stream/);
const reader = sseRes.body.getReader();
const first = await reader.read();
const chunkText = new TextDecoder().decode(first.value);
assert.match(chunkText, /"type":"CONNECTED"/);
controller.abort();
await reader.cancel().catch(() => {});
console.log('✔ Test 3 Passed: /api/v1/stream opens and emits the initial snapshot');

// Test 4: rewritten entrypoints (/graphql -> /api/graphql, /metrics -> /api/metrics)
console.log('Test 4: rewritten GraphQL and metrics entrypoints...');
const graphqlFn = (await import('../api/graphql.mjs')).default;
const gql = await serve(graphqlFn);
const gqlRes = await fetch(`${gql.base}/api/graphql`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '{ topology { nodeCount edgeCount } }' }),
});
assert.strictEqual(gqlRes.status, 200);
const gqlBody = await gqlRes.json();
assert.ok(gqlBody.data.topology.nodeCount >= 15, `GraphQL saw ${JSON.stringify(gqlBody)}`);

const metricsFn = (await import('../api/metrics.mjs')).default;
const metrics = await serve(metricsFn);
const metricsRes = await fetch(`${metrics.base}/api/metrics`);
assert.strictEqual(metricsRes.status, 200);
assert.match(metricsRes.headers.get('content-type'), /text\/plain/);
const metricsText = await metricsRes.text();
assert.match(metricsText, /flowcartographer_nodes_total \d+/);
console.log('✔ Test 4 Passed: rewritten paths resolve through the shared handler');

await v1.close();
await gql.close();
await metrics.close();
fs.rmSync(blocker, { force: true });
console.log('All Vercel entrypoint tests passed! 🎉');
process.exit(0);
