# FlowCartographer

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![eBPF](https://img.shields.io/badge/eBPF-CO--RE-purple.svg)](https://ebpf.io/)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-1.26+-326ce5.svg)](https://kubernetes.io/)

> **eBPF-Powered Real-Time Service Dependency Topology Generator for Kubernetes**  
> Complete service dependency mapping with **zero instrumentation**, **zero sidecars**, and **<1% compute overhead**.

---

## Highlights

- **Zero-Touch Discovery:** Operates in Linux kernel space via eBPF probes attached to `tcp_connect`, `inet_accept`, `udp_sendmsg` (DNS), and `execve`.
- **Sidecar-Free Architecture:** Eliminates Envoy/sidecar proxies, saving CPU and eliminating artificial network hops.
- **Transitive Blast Radius Analyzer:** Automatically calculates upstream cascading failures when downstream microservices degrade.
- **Dual-Store Persistence:** In-memory graph model backed by persistent SQLite / ClickHouse historical telemetry snapshots.
- **Time-Travel Topology Replay:** Scrub back in time to inspect earlier architectural states and debug deployment regressions.
- **Interactive High-Performance Visualization:** SVG + Canvas hybrid renderer featuring real-time moving traffic particles, namespace clustering, and instant golden signals telemetry.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         KUBERNETES CLUSTER                                   │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │   Node 1        │  │   Node 2        │  │   Node N        │              │
│  │  ┌───────────┐  │  │  ┌───────────┐  │  │  ┌───────────┐  │              │
│  │  │ eBPF      │  │  │  │ eBPF      │  │  │  │ eBPF      │  │              │
│  │  │ Programs  │  │  │  │ Programs  │  │  │  │ Programs  │  │              │
│  │  │ (Kernel)  │  │  │  │ (Kernel)  │  │  │  │ (Kernel)  │  │              │
│  │  └─────┬─────┘  │  │  └─────┬─────┘  │  │  └─────┬─────┘  │              │
│  │        │ RingBuf (mmap)     │                 │                           │
│  │  ┌─────▼─────┐  │  │  ┌─────▼─────┐  │  │  ┌─────▼─────┐  │              │
│  │  │ Agent     │  │  │  │ Agent     │  │  │  │ Agent     │  │              │
│  │  │ (DaemonSet)│ │  │  │ (DaemonSet)│ │  │  │ (DaemonSet)│ │              │
│  │  └─────┬─────┘  │  │  └─────┬─────┘  │  │  └─────┬─────┘  │              │
│  └────────┼────────┘  └────────┼────────┘  └────────┼────────┘              │
│           │                    │                    │                        │
│           └────────────────────┼────────────────────┘                        │
│                                │ gRPC / HTTP Batches                         │
│  ┌─────────────────────────────▼─────────────────────────────┐               │
│  │                    AGGREGATOR LAYER                        │               │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │               │
│  │  │ Ingestion & │  │ Topology    │  │ Dual-Store      │   │               │
│  │  │ Reconciler  │  │ Graph Engine│  │ Persistence     │   │               │
│  │  │ (Sliding)   │  │ (Blast Rad) │  │ (Snapshots & DB)│   │               │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │               │
│  └─────────────────────────────┬─────────────────────────────┘               │
│                                │                                             │
│  ┌─────────────────────────────▼─────────────────────────────┐               │
│  │                    API & VISUALIZATION                     │               │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │               │
│  │  │ GraphQL     │  │ WebSocket / │  │ Interactive     │   │               │
│  │  │ API         │  │ SSE Stream  │  │ D3/Canvas UI    │   │               │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │               │
│  └──────────────────────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘
```

For the full architectural specification, refer to the [Comprehensive Technical Blueprint](BLUEPRINT.md).

---

## Directory Structure

```
FlowCartographer/
├── BLUEPRINT.md             # Complete Technical Blueprint & Architectural Spec
├── bpf/                     # Kernel-space eBPF C Programs
│   ├── flow_cartographer.h  # Common headers & event struct definitions
│   ├── tcp_connect.bpf.c    # Outbound TCP client connection kprobe
│   ├── inet_accept.bpf.c    # Inbound TCP server accept kretprobe
│   ├── dns_tracker.bpf.c    # UDP port 53 DNS query tracer
│   ├── exec_tracker.bpf.c   # execve binary identifier tracepoint
│   └── Makefile             # Clang / LLVM BPF compilation
├── agent/                   # Go Userspace DaemonSet Agent
│   ├── main.go              # Agent entrypoint and lifecycle orchestrator
│   ├── pod_cache.go         # K8s Informers, NetNS inode extractor & IP index
│   ├── enricher.go          # Telemetry enrichment (IP/NetNS -> Pod/Service)
│   ├── batcher.go           # Lockless sliding-window event batcher
│   ├── exporter.go          # HTTP/gRPC streaming client to aggregator
│   ├── bpf_loader.go        # Kernel BPF loader and simulation generator
│   ├── config.go            # Agent configuration options
│   ├── types.go             # Structs and event definitions
│   ├── go.mod               # Go module definition (run `go mod tidy` to generate go.sum)
│   └── agent_test.go        # Unit tests
├── server/                  # Aggregator, Topology Engine & Storage Layer
│   ├── index.mjs            # Standalone HTTP server entrypoint (npm start)
│   ├── app.mjs              # Application core: graph bootstrap + request handler
│   ├── graph_engine.mjs     # Directed Graph Engine & Blast Radius Traverser
│   ├── db.mjs               # SQLite storage (auto-falls back to in-memory)
│   ├── simulator.mjs        # Microservices flow generator & anomaly injector
│   └── graphql_handler.mjs  # GraphQL schema and query resolver
├── api/                     # Vercel (serverless) entrypoints -> server/app.mjs
│   ├── v1/[...path].mjs     # Catch-all for the whole /api/v1 surface
│   ├── graphql.mjs          # POST /graphql (rewritten from /api/graphql)
│   └── metrics.mjs          # GET /metrics (rewritten from /api/metrics)
├── public/                  # Modern Web Visualization Dashboard
│   ├── index.html           # Dashboard HTML5 layout
│   ├── style.css            # Dark cyberpunk cloud-native theme
│   └── app.js               # Hybrid Canvas/SVG D3 physics engine
├── deploy/                  # Production Kubernetes Manifests & Helm Chart
│   ├── daemonset.yaml       # eBPF Agent DaemonSet with BPF capabilities
│   ├── aggregator.yaml      # Aggregator Deployment and Service
│   ├── rbac.yaml            # RBAC ClusterRole and Bindings
│   └── helm/                # Helm deployment package
├── test/                    # Test Suites
│   ├── test_flowcartographer.mjs   # Graph engine, persistence, GraphQL, anomalies
│   └── test_vercel_functions.mjs   # Serverless entrypoint / deployment checks
├── vercel.json              # Vercel deployment config (functions + static + rewrites)
└── package.json
```

---

## Quickstart

### 1. Launch Aggregator and Web Dashboard
```bash
npm start
```
The server will start on port `8080`.
Open your browser at `http://localhost:8080` to view the interactive live service dependency map.

### 2. Run Test Suite
```bash
npm test
```

### 3. Deploy to Vercel (dashboard + API)

The web dashboard and the aggregator API run as Node.js Serverless Functions; the eBPF
agent is **not** deployed there (see the note below).

1. In the Vercel project, open **Settings → General → Root Directory** and set it to the
   **repository root** (`.`). If it points at `agent/`, Vercel tries to compile the Go
   eBPF agent as a serverless function and the build fails.
2. Import the repository (Framework Preset: **Other**) and deploy. `vercel.json` wires
   everything up: `public/` is served statically and `api/**` becomes Node 22 functions.
3. Verify: `/`, `/api/v1/topology`, `/graphql` and `/metrics`.

```bash
# Local preview of exactly what Vercel builds
npm run vercel-build   # no-op: the app needs no build step
npm test               # includes the serverless entrypoint suite
```

Serverless notes:

* The filesystem is read-only and ephemeral, so snapshots are kept in memory for the
  lifetime of a warm instance. Set `DATABASE_PATH` to a writable location if you want
  SQLite persistence instead.
* Each warm function instance runs its own graph/simulator; the built-in demo traffic is
  generated in-process, so a cold start re-seeds the topology.
* Long-lived SSE responses are cut off at the function timeout, so the dashboard
  automatically falls back to polling `/api/v1/topology` when the stream drops.

> **The eBPF agent does not run on Vercel.** `agent/` needs a privileged Linux kernel,
> `CAP_BPF`/`CAP_SYS_ADMIN`, and access to the cluster API, so it is deployed as a
> Kubernetes DaemonSet (`deploy/daemonset.yaml`). Build it with
> `cd agent && go mod tidy && go build -o agent .` — `go mod tidy` generates the
> `go.sum` lockfile on the first run, which is required for any `go build` (including CI
> and container images).

### 4. Deploy to Kubernetes
```bash
# Apply RBAC and Service Accounts
kubectl apply -f deploy/rbac.yaml

# Deploy FlowCartographer Aggregator
kubectl apply -f deploy/aggregator.yaml

# Deploy eBPF Agent DaemonSet
kubectl apply -f deploy/daemonset.yaml
```

---

## API Documentation

### REST API
- `GET /api/v1/topology` — Current graph topology (nodes, edges, metrics). Supports `?namespace=...` filter.
- `GET /api/v1/topology/history` — Historical snapshots for time-travel debugging (`?limit=20`).
- `GET /api/v1/services` — List of all observed services.
- `GET /api/v1/services/:id/blast-radius` — Transitive upstream blast radius analysis for a given service.
- `POST /api/v1/simulate/anomaly` — Injects or clears simulated outage on a service (e.g. `{"target": "payment-service"}`).
- `POST /api/v1/events` — Ingestion endpoint for eBPF agent event batches.
- `GET /api/v1/stream` — Server-Sent Events (SSE) real-time streaming endpoint for live UI updates.
- `GET /metrics` — Prometheus metrics exporter.

### GraphQL API
Send `POST /graphql` with JSON body `{"query": "..."}`:
```graphql
query GetServiceMap {
  topology {
    nodeCount
    edgeCount
    nodes {
      name
      namespace
      type
      status
      metrics {
        requestRate
        latencyP95
        errorRate
      }
    }
  }
}
```

---

## License
Apache License 2.0. See LICENSE for details.
