package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/sirupsen/logrus"
)

type BatchPayload struct {
	NodeName  string           `json:"nodeName"`
	Timestamp time.Time        `json:"timestamp"`
	Events    []*EnrichedEvent `json:"events"`
}

type Exporter struct {
	endpoint string
	nodeName string
	client   *http.Client
}

func NewExporter(endpoint string, nodeName string) *Exporter {
	return &Exporter{
		endpoint: endpoint,
		nodeName: nodeName,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func (e *Exporter) Run(ctx context.Context, batches <-chan []*EnrichedEvent) {
	logrus.Infof("Exporter started, streaming batches to %s", e.endpoint)
	for {
		select {
		case <-ctx.Done():
			return
		case batch, ok := <-batches:
			if !ok {
				return
			}
			if err := e.sendBatch(ctx, batch); err != nil {
				logrus.Warnf("Failed to send event batch to %s: %v", e.endpoint, err)
			}
		}
	}
}

func (e *Exporter) sendBatch(ctx context.Context, events []*EnrichedEvent) error {
	payload := BatchPayload{
		NodeName:  e.nodeName,
		Timestamp: time.Now().UTC(),
		Events:    events,
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshalling batch: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", e.endpoint, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "FlowCartographer-Agent/1.0")

	resp, err := e.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("aggregator returned HTTP %d", resp.StatusCode)
	}

	return nil
}
