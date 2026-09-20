package main

import (
	"context"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/sirupsen/logrus"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func main() {
	logrus.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
	logrus.Info("Starting FlowCartographer eBPF Agent")

	config := LoadConfig()
	logrus.Infof("Configuration: Node=%s, Aggregator=%s, BatchSize=%d, SimMode=%v",
		config.NodeName, config.AggregatorURL, config.BatchSize, config.SimulationMode)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		logrus.Info("Shutdown signal caught, terminating gracefully...")
		cancel()
	}()

	// In-cluster K8s configuration (optional if in standalone/sim mode)
	var k8sClient *kubernetes.Clientset
	k8sConfig, err := rest.InClusterConfig()
	if err == nil {
		k8sClient, err = kubernetes.NewForConfig(k8sConfig)
		if err != nil {
			logrus.Warnf("Failed to initialize Kubernetes client: %v", err)
		}
	} else {
		logrus.Info("Running outside Kubernetes cluster or without in-cluster credentials")
	}

	podCache := NewPodCache(k8sClient, config.NodeName)
	enricher := NewMetadataEnricher(podCache, config.NodeName)
	batcher := NewEventBatcher(config.BatchSize, config.BatchInterval)
	loader := NewBPFLoader(config, enricher, batcher)
	exporter := NewExporter(config.AggregatorURL, config.NodeName)

	var wg sync.WaitGroup

	// Start Pod Cache informer
	wg.Add(1)
	go func() {
		defer wg.Done()
		podCache.Run(ctx)
	}()

	// Start Batcher
	wg.Add(1)
	go func() {
		defer wg.Done()
		batcher.Run(ctx)
	}()

	// Start Exporter
	wg.Add(1)
	go func() {
		defer wg.Done()
		exporter.Run(ctx, batcher.Batches())
	}()

	// Start eBPF loader / traffic capture
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := loader.Start(ctx); err != nil {
			logrus.Errorf("Loader error: %v", err)
		}
	}()

	logrus.Info("FlowCartographer Agent initialized and actively observing network flows")
	wg.Wait()
	logrus.Info("FlowCartographer Agent terminated cleanly")
}
