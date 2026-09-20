// FlowCartographer Built-in Cluster Flow Simulator
// Generates realistic multi-tier microservice network traffic with dynamic packet rates and latencies

export class ClusterSimulator {
  constructor(graphEngine) {
    this.engine = graphEngine;
    this.intervalId = null;
    this.running = false;

    // Pre-seed canonical nodes
    this.services = [
      { name: 'ingress-nginx', namespace: 'ingress', type: 'INGRESS', workloadKind: 'DaemonSet', ip: '10.244.0.10' },
      { name: 'web-frontend', namespace: 'default', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.1.15' },
      { name: 'api-gateway', namespace: 'default', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.1.20' },
      { name: 'auth-service', namespace: 'default', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.1.25' },
      { name: 'catalog-service', namespace: 'default', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.1.30' },
      { name: 'order-service', namespace: 'default', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.1.35' },
      { name: 'cart-service', namespace: 'default', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.1.40' },
      { name: 'payment-service', namespace: 'default', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.1.45' },
      { name: 'shipping-worker', namespace: 'platform', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.2.10' },
      { name: 'notification-service', namespace: 'platform', type: 'SERVICE', workloadKind: 'Deployment', ip: '10.244.2.20' },
      { name: 'postgres-master', namespace: 'storage', type: 'DATABASE', workloadKind: 'StatefulSet', ip: '10.244.3.10' },
      { name: 'redis-cache', namespace: 'storage', type: 'DATABASE', workloadKind: 'StatefulSet', ip: '10.244.3.20' },
      { name: 'kafka-cluster', namespace: 'platform', type: 'KAFKA', workloadKind: 'StatefulSet', ip: '10.244.2.30' },
      { name: 'stripe-api', namespace: 'external', type: 'EXTERNAL', workloadKind: 'ExternalHost', ip: '54.187.210.12' },
      { name: 'sendgrid-api', namespace: 'external', type: 'EXTERNAL', workloadKind: 'ExternalHost', ip: '198.2.130.5' },
    ];

    this.flows = [
      { from: 'ingress-nginx', to: 'web-frontend', proto: 'HTTP', port: 80, baseRate: 15, baseLat: 1.2 },
      { from: 'web-frontend', to: 'api-gateway', proto: 'HTTP', port: 8080, baseRate: 14, baseLat: 2.1 },
      { from: 'api-gateway', to: 'auth-service', proto: 'gRPC', port: 50051, baseRate: 12, baseLat: 1.8 },
      { from: 'api-gateway', to: 'catalog-service', proto: 'HTTP', port: 8080, baseRate: 10, baseLat: 3.5 },
      { from: 'api-gateway', to: 'cart-service', proto: 'HTTP', port: 8080, baseRate: 8, baseLat: 2.4 },
      { from: 'api-gateway', to: 'order-service', proto: 'HTTP', port: 8080, baseRate: 6, baseLat: 4.8 },
      { from: 'order-service', to: 'payment-service', proto: 'HTTP', port: 8443, baseRate: 5, baseLat: 8.5 },
      { from: 'payment-service', to: 'stripe-api', proto: 'HTTPS', port: 443, baseRate: 4, baseLat: 28.0 },
      { from: 'order-service', to: 'postgres-master', proto: 'DATABASE', port: 5432, baseRate: 6, baseLat: 2.2 },
      { from: 'order-service', to: 'kafka-cluster', proto: 'KAFKA', port: 9092, baseRate: 5, baseLat: 1.9 },
      { from: 'catalog-service', to: 'postgres-master', proto: 'DATABASE', port: 5432, baseRate: 7, baseLat: 1.8 },
      { from: 'catalog-service', to: 'redis-cache', proto: 'REDIS', port: 6379, baseRate: 11, baseLat: 0.8 },
      { from: 'cart-service', to: 'redis-cache', proto: 'REDIS', port: 6379, baseRate: 9, baseLat: 0.9 },
      { from: 'kafka-cluster', to: 'shipping-worker', proto: 'TCP', port: 9092, baseRate: 4, baseLat: 1.5 },
      { from: 'kafka-cluster', to: 'notification-service', proto: 'TCP', port: 9092, baseRate: 5, baseLat: 1.4 },
      { from: 'notification-service', to: 'sendgrid-api', proto: 'HTTPS', port: 443, baseRate: 3, baseLat: 34.0 },
    ];
  }

  seed() {
    for (const svc of this.services) {
      this.engine.upsertNode(svc);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.seed();

    this.intervalId = setInterval(() => {
      this.step();
    }, 400);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  step() {
    const svcMap = new Map(this.services.map(s => [s.name, s]));

    // Pick 5-10 flows per pulse
    const count = 5 + Math.floor(Math.random() * 6);
    for (let i = 0; i < count; i++) {
      const flow = this.flows[Math.floor(Math.random() * this.flows.length)];
      const src = svcMap.get(flow.from);
      const dst = svcMap.get(flow.to);
      if (!src || !dst) continue;

      // Jitter latency slightly
      const jitter = (Math.random() - 0.4) * 0.8;
      const lat = Math.max(0.5, flow.baseLat + jitter);
      const bytes = Math.floor(400 + Math.random() * 3200);

      this.engine.upsertEdge(src, dst, {
        protocol: flow.proto,
        port: flow.port,
        latencyMs: lat,
        bytes,
        isError: false,
      });
    }
  }
}
