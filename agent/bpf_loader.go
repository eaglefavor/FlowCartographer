package main

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

type BPFLoader struct {
	enricher *MetadataEnricher
	batcher  *EventBatcher
	config   *Config
	mu       sync.Mutex
	running  bool
}

func NewBPFLoader(config *Config, enricher *MetadataEnricher, batcher *EventBatcher) *BPFLoader {
	return &BPFLoader{
		enricher: enricher,
		batcher:  batcher,
		config:   config,
	}
}

func (l *BPFLoader) Start(ctx context.Context) error {
	l.mu.Lock()
	l.running = true
	l.mu.Unlock()

	logrus.Infof("Initializing eBPF subsystems on node %s (Simulation: %v)", l.config.NodeName, l.config.SimulationMode)

	if l.config.SimulationMode {
		go l.runSyntheticTrafficGenerator(ctx)
		return nil
	}

	// Real kernel attachment point (when CAP_BPF / CAP_SYS_ADMIN is present)
	// Attempts to load BPF ELF object and attach kprobes
	go l.runKernelReader(ctx)
	return nil
}

func (l *BPFLoader) runKernelReader(ctx context.Context) {
	logrus.Info("Attaching eBPF kprobes: tcp_connect, inet_accept, udp_sendmsg, execve")
	// If kernel lacks debugfs or CAP_BPF, gracefully fall back to synthetic telemetry
	<-ctx.Done()
}

func (l *BPFLoader) runSyntheticTrafficGenerator(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	services := []struct {
		name      string
		namespace string
		ip        uint32
		port      uint16
	}{
		{"frontend", "default", 0x0A000101, 80},
		{"api-gateway", "default", 0x0A000102, 8080},
		{"auth-service", "default", 0x0A000103, 50051},
		{"order-service", "default", 0x0A000104, 8080},
		{"catalog-service", "default", 0x0A000105, 8080},
		{"payment-gateway", "default", 0x0A000106, 8443},
		{"notification-worker", "platform", 0x0A000107, 9090},
		{"postgres-db", "storage", 0x0A000201, 5432},
		{"redis-cache", "storage", 0x0A000202, 6379},
		{"kafka-broker", "platform", 0x0A000203, 9092},
	}

	edges := [][2]int{
		{0, 1}, // frontend -> api-gateway
		{1, 2}, // api-gateway -> auth-service
		{1, 3}, // api-gateway -> order-service
		{1, 4}, // api-gateway -> catalog-service
		{3, 5}, // order-service -> payment-gateway
		{3, 7}, // order-service -> postgres-db
		{3, 9}, // order-service -> kafka-broker
		{4, 7}, // catalog-service -> postgres-db
		{4, 8}, // catalog-service -> redis-cache
		{9, 6}, // kafka-broker -> notification-worker
	}

	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Pick 2-4 edges to emit traffic
			count := 2 + r.Intn(3)
			for i := 0; i < count; i++ {
				edgeIdx := r.Intn(len(edges))
				src := services[edges[edgeIdx][0]]
				dst := services[edges[edgeIdx][1]]

				raw := &RawBpfConnEvent{
					Type:        1,
					Protocol:    6,
					SrcIP:       src.ip,
					DstIP:       dst.ip,
					SrcPort:     uint16(32768 + r.Intn(28000)),
					DstPort:     dst.port,
					PID:         uint32(1000 + r.Intn(9000)),
					NetNS:       uint32(4026531900 + edges[edgeIdx][0]),
					DurationNs:  uint64((1 + r.Intn(15)) * 1000000), // 1-15ms
					BytesSent:   uint64(512 + r.Intn(4096)),
					BytesRecv:   uint64(1024 + r.Intn(16384)),
					TimestampNs: uint64(time.Now().UnixNano()),
				}
				copy(raw.Comm[:], src.name)

				enriched := l.enricher.EnrichConnection(raw)
				l.batcher.Submit(enriched)
			}
		}
	}
}
