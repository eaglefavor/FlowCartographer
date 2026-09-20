// Automated Verification Test Suite for FlowCartographer

import assert from 'node:assert';
import { PersistenceStore } from '../server/db.mjs';
import { GraphEngine } from '../server/graph_engine.mjs';
import { handleGraphQLQuery } from '../server/graphql_handler.mjs';

console.log('--- Running FlowCartographer Test Suite ---');

// Test 1: Persistence Store Initialisation & Schema
console.log('Test 1: Testing SQLite Persistence Store...');
const store = new PersistenceStore(':memory:');
store.saveSnapshot(new Date().toISOString(), [{ id: 'test-node' }], [{ id: 'test-edge' }]);
const snapshots = store.getSnapshots(5);
assert.strictEqual(snapshots.length, 1, 'Should store 1 snapshot');
assert.strictEqual(snapshots[0].nodes[0].id, 'test-node');
console.log('✔ Test 1 Passed: Persistence store works correctly');

// Test 2: GraphEngine Upsert & Ingestion
console.log('Test 2: Testing Graph Engine and Flow Ingestion...');
const engine = new GraphEngine(store);

// Ingest a batch of simulated events
const sampleBatch = {
  nodeName: 'worker-node-1',
  events: [
    {
      type: 'CONNECT',
      protocol: 'HTTP',
      source: { service: 'web-frontend', namespace: 'default', ip: '10.244.1.15', port: 48920 },
      dest: { service: 'api-gateway', namespace: 'default', ip: '10.244.1.20', port: 8080 },
      durationNs: 2400000,
      bytesSent: 1024,
      bytesRecv: 4096,
    },
    {
      type: 'CONNECT',
      protocol: 'HTTP',
      source: { service: 'api-gateway', namespace: 'default', ip: '10.244.1.20', port: 51230 },
      dest: { service: 'order-service', namespace: 'default', ip: '10.244.1.35', port: 8080 },
      durationNs: 4200000,
      bytesSent: 2048,
      bytesRecv: 2048,
    },
    {
      type: 'CONNECT',
      protocol: 'HTTPS',
      source: { service: 'order-service', namespace: 'default', ip: '10.244.1.35', port: 39810 },
      dest: { service: 'payment-service', namespace: 'default', ip: '10.244.1.45', port: 8443 },
      durationNs: 12000000,
      bytesSent: 512,
      bytesRecv: 1024,
    },
  ],
};

const result = engine.ingestBatch(sampleBatch);
assert.strictEqual(result.processed, 3, 'Should process 3 flow events');

const topo = engine.getTopology();
assert.strictEqual(topo.nodes.length, 4, 'Should contain 4 nodes');
assert.strictEqual(topo.edges.length, 3, 'Should contain 3 edges');
console.log('✔ Test 2 Passed: Flow batch successfully ingested and graph updated');

// Test 3: Transitive Blast Radius Calculation
console.log('Test 3: Testing Blast Radius Algorithm...');
// Downstream target is payment-service:
// Chain: web-frontend -> api-gateway -> order-service -> payment-service
// When payment-service fails, upstream blast radius should cascade to order-service, api-gateway, web-frontend!
const paymentNodeId = 'default/payment-service';
const blast = engine.computeBlastRadius(paymentNodeId);

assert.strictEqual(blast.rootCauseNodeId, paymentNodeId);
assert.strictEqual(blast.totalAffectedServices, 3, 'Should affect 3 upstream services (order-service, api-gateway, web-frontend)');
assert(blast.affectedNodeIds.includes('default/order-service'), 'Should include order-service');
assert(blast.affectedNodeIds.includes('default/api-gateway'), 'Should include api-gateway');
assert(blast.affectedNodeIds.includes('default/web-frontend'), 'Should include web-frontend');
assert.strictEqual(blast.impactSeverity, 'CRITICAL', 'Should be CRITICAL impact because web-frontend is affected');
console.log(`✔ Test 3 Passed: Blast radius calculated correctly (${blast.totalAffectedServices} services, severity: ${blast.impactSeverity})`);

// Test 4: GraphQL Handler
console.log('Test 4: Testing GraphQL Resolver...');
const gqlQuery = `
  query GetTopology {
    topology {
      nodeCount
      edgeCount
    }
  }
`;
const gqlRes = handleGraphQLQuery(gqlQuery, {}, engine, store);
assert(gqlRes.data && gqlRes.data.topology, 'GraphQL response must contain topology');
assert.strictEqual(gqlRes.data.topology.nodeCount, 4);
assert.strictEqual(gqlRes.data.topology.edgeCount, 3);

const gqlBlastQuery = `
  query GetBlast($nodeId: ID!) {
    blastRadius(nodeId: "default/payment-service") {
      impactSeverity
      totalAffectedServices
    }
  }
`;
const blastRes = handleGraphQLQuery(gqlBlastQuery, {}, engine, store);
assert.strictEqual(blastRes.data.blastRadius.impactSeverity, 'CRITICAL');
assert.strictEqual(blastRes.data.blastRadius.totalAffectedServices, 3);
console.log('✔ Test 4 Passed: GraphQL resolver successfully answered queries');

// Test 5: Simulated Anomaly Toggle
console.log('Test 5: Testing Anomaly Injection...');
const anomaly = engine.toggleAnomaly('payment-service');
assert.strictEqual(anomaly.active, true, 'Anomaly should be active');
engine.tick();
const updatedPaymentNode = engine.nodes.get(anomaly.targetNodeId);
assert.strictEqual(updatedPaymentNode.status, 'FAILING', 'Payment service must be FAILING under outage');

const reset = engine.toggleAnomaly('payment-service');
assert.strictEqual(reset.active, false, 'Anomaly should now be reset');
console.log('✔ Test 5 Passed: Anomaly lifecycle works as intended');

// Teardown
clearInterval(engine.decayTimer);
clearInterval(engine.snapshotTimer);
store.close();

console.log('All FlowCartographer test suites passed with 100% success! 🎉');
