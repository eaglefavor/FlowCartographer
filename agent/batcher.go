package main

import (
	"context"
	"sync"
	"time"
)

type EventBatcher struct {
	batchSize     int
	batchInterval time.Duration
	inChan        chan *EnrichedEvent
	batches       chan []*EnrichedEvent
	mu            sync.Mutex
	buffer        []*EnrichedEvent
}

func NewEventBatcher(size int, interval time.Duration) *EventBatcher {
	return &EventBatcher{
		batchSize:     size,
		batchInterval: interval,
		inChan:        make(chan *EnrichedEvent, 50000),
		batches:       make(chan []*EnrichedEvent, 1000),
		buffer:        make([]*EnrichedEvent, 0, size),
	}
}

func (b *EventBatcher) Submit(event *EnrichedEvent) {
	select {
	case b.inChan <- event:
	default:
		// Queue saturated; drop or bump metrics
	}
}

func (b *EventBatcher) Batches() <-chan []*EnrichedEvent {
	return b.batches
}

func (b *EventBatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(b.batchInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			b.flush()
			return
		case event := <-b.inChan:
			b.mu.Lock()
			b.buffer = append(b.buffer, event)
			needFlush := len(b.buffer) >= b.batchSize
			b.mu.Unlock()
			if needFlush {
				b.flush()
			}
		case <-ticker.C:
			b.flush()
		}
	}
}

func (b *EventBatcher) flush() {
	b.mu.Lock()
	if len(b.buffer) == 0 {
		b.mu.Unlock()
		return
	}
	out := make([]*EnrichedEvent, len(b.buffer))
	copy(out, b.buffer)
	b.buffer = b.buffer[:0]
	b.mu.Unlock()

	select {
	case b.batches <- out:
	default:
		// Aggregator backpressure
	}
}
