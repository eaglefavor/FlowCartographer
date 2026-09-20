package main

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	NodeName           string
	AggregatorURL      string
	BatchSize          int
	BatchInterval      time.Duration
	EnableDNSCapture   bool
	EnableProcessTrace bool
	SimulationMode     bool
}

func LoadConfig() *Config {
	nodeName := os.Getenv("NODE_NAME")
	if nodeName == "" {
		host, err := os.Hostname()
		if err == nil {
			nodeName = host
		} else {
			nodeName = "k8s-node-worker-1"
		}
	}

	aggregatorURL := os.Getenv("AGGREGATOR_ENDPOINT")
	if aggregatorURL == "" {
		aggregatorURL = "http://localhost:8080/api/v1/events"
	}

	batchSize := 500
	if bs := os.Getenv("BATCH_SIZE"); bs != "" {
		if val, err := strconv.Atoi(bs); err == nil && val > 0 {
			batchSize = val
		}
	}

	batchInterval := 500 * time.Millisecond
	if bi := os.Getenv("BATCH_INTERVAL_MS"); bi != "" {
		if val, err := strconv.Atoi(bi); err == nil && val > 0 {
			batchInterval = time.Duration(val) * time.Millisecond
		}
	}

	simMode := os.Getenv("SIMULATION_MODE") == "true" || os.Getenv("KUBERNETES_SERVICE_HOST") == ""

	return &Config{
		NodeName:           nodeName,
		AggregatorURL:      aggregatorURL,
		BatchSize:          batchSize,
		BatchInterval:      batchInterval,
		EnableDNSCapture:   os.Getenv("ENABLE_DNS_CAPTURE") != "false",
		EnableProcessTrace: os.Getenv("ENABLE_PROCESS_TRACE") != "false",
		SimulationMode:     simMode,
	}
}
