// FlowCartographer Aggregator & Topology Engine Server
// Native Node.js 22 ES Module server (zero external npm dependencies required)
//
// The routing logic lives in ./app.mjs so the identical API can also be deployed as
// serverless functions (see /api and vercel.json). This file only owns the socket.

import http from 'node:http';
import { createApp, createHandler, resolveDbPath } from './app.mjs';

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const app = createApp({ dbPath: resolveDbPath() });
const server = http.createServer(createHandler(app));

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`FlowCartographer Aggregator & Topology Engine v1.0.0`);
  console.log(`Kernel-Level eBPF Service Map Generator`);
  console.log(`Persistence:         ${app.persistence} (${app.dbPath})`);
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Web Dashboard:       http://localhost:${PORT}`);
  console.log(`Topology REST API:   http://localhost:${PORT}/api/v1/topology`);
  console.log(`SSE Live Stream:     http://localhost:${PORT}/api/v1/stream`);
  console.log(`Prometheus Metrics:  http://localhost:${PORT}/metrics`);
  console.log(`GraphQL Endpoint:    http://localhost:${PORT}/graphql`);
  console.log(`=======================================================`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down FlowCartographer aggregator...`);
  app.simulator.stop();
  server.close(() => {
    try {
      app.store.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  // Do not hang forever on lingering SSE connections.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
