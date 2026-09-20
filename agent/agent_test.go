package main

import (
	"context"
	"testing"
	"time"
)

func TestMetadataEnricher(t *testing.T) {
	pc := NewPodCache(nil, "test-node")
	pc.AddStaticPod(&PodInfo{
		Name:         "payment-service",
		Namespace:    "default",
		IP:           "10.244.1.45",
		WorkloadKind: "Deployment",
		NetNS:        4026532840,
	})

	enricher := NewMetadataEnricher(pc, "test-node")

	raw := &RawBpfConnEvent{
		Type:        1,
		Protocol:    6,
		SrcIP:       0x0A000101, // 10.0.1.1
		DstIP:       0x2D01F40A, // 10.244.1.45 (little-endian)
		SrcPort:     48210,
		DstPort:     8080,
		PID:         1234,
		NetNS:       4026532840,
		DurationNs:  1500000,
		BytesSent:   1024,
		BytesRecv:   2048,
		TimestampNs: uint64(time.Now().UnixNano()),
	}

	copy(raw.Comm[:], "order-service")

	event := enricher.EnrichConnection(raw)

	if event.Dest.PodName != "payment-service" {
		t.Errorf("Expected dest pod payment-service, got %s", event.Dest.PodName)
	}

	if event.Source.Process != "order-service" {
		t.Errorf("Expected source process order-service, got %s", event.Source.Process)
	}

	if event.Protocol != "HTTP" {
		t.Errorf("Expected HTTP protocol for port 8080, got %s", event.Protocol)
	}
}

func TestEventBatcher(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	batcher := NewEventBatcher(5, 50*time.Millisecond)
	go batcher.Run(ctx)

	for i := 0; i < 5; i++ {
		batcher.Submit(&EnrichedEvent{
			ID:       "evt-1",
			NodeName: "test-node",
		})
	}

	select {
	case batch := <-batcher.Batches():
		if len(batch) != 5 {
			t.Errorf("Expected batch of 5 events, got %d", len(batch))
		}
	case <-time.After(500 * time.Millisecond):
		t.Errorf("Timed out waiting for batch flush")
	}
}
