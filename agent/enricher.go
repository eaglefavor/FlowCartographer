package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"time"
)

type MetadataEnricher struct {
	podCache *PodCache
	nodeName string
}

func NewMetadataEnricher(podCache *PodCache, nodeName string) *MetadataEnricher {
	return &MetadataEnricher{
		podCache: podCache,
		nodeName: nodeName,
	}
}

func intToIP(val uint32) net.IP {
	ip := make(net.IP, 4)
	ip[0] = byte(val)
	ip[1] = byte(val >> 8)
	ip[2] = byte(val >> 16)
	ip[3] = byte(val >> 24)
	return ip
}

func cStringToString(b []byte) string {
	n := bytes.IndexByte(b, 0)
	if n == -1 {
		return string(b)
	}
	return string(b[:n])
}

func (e *MetadataEnricher) EnrichConnection(raw *RawBpfConnEvent) *EnrichedEvent {
	srcIP := intToIP(raw.SrcIP)
	dstIP := intToIP(raw.DstIP)
	comm := cStringToString(raw.Comm[:])

	// Attempt resolution via NetNS first, fallback to IP
	var srcPod *PodInfo
	if raw.NetNS > 0 {
		srcPod = e.podCache.GetPodByNetNS(raw.NetNS)
	}
	if srcPod == nil {
		srcPod = e.podCache.GetPodByIP(srcIP.String())
	}

	dstPod := e.podCache.GetPodByIP(dstIP.String())
	dstSvc := e.podCache.ResolveService(dstIP.String(), raw.DstPort)

	srcEndpoint := Endpoint{
		IP:      srcIP,
		Port:    raw.SrcPort,
		Process: comm,
		PID:     raw.PID,
		NetNS:   raw.NetNS,
	}
	if srcPod != nil {
		srcEndpoint.PodName = srcPod.Name
		srcEndpoint.Namespace = srcPod.Namespace
		srcEndpoint.WorkloadKind = srcPod.WorkloadKind
		srcEndpoint.Labels = srcPod.Labels
		srcEndpoint.Service = srcPod.Name // Default workload mapping
	} else {
		srcEndpoint.Namespace = "default"
		srcEndpoint.Service = comm
	}

	dstEndpoint := Endpoint{
		IP:   dstIP,
		Port: raw.DstPort,
	}
	if dstSvc != nil {
		dstEndpoint.Service = dstSvc.Name
		dstEndpoint.Namespace = dstSvc.Namespace
		dstEndpoint.WorkloadKind = "Service"
	} else if dstPod != nil {
		dstEndpoint.PodName = dstPod.Name
		dstEndpoint.Namespace = dstPod.Namespace
		dstEndpoint.WorkloadKind = dstPod.WorkloadKind
		dstEndpoint.Service = dstPod.Name
		dstEndpoint.Labels = dstPod.Labels
	} else {
		// External destination classification
		dstEndpoint.Namespace = "external"
		dstEndpoint.Service = fmt.Sprintf("ext-%s", dstIP.String())
		dstEndpoint.WorkloadKind = "ExternalHost"
	}

	proto := "TCP"
	if raw.DstPort == 80 || raw.DstPort == 8080 || raw.DstPort == 3000 {
		proto = "HTTP"
	} else if raw.DstPort == 50051 || raw.DstPort == 9090 {
		proto = "gRPC"
	} else if raw.DstPort == 5432 || raw.DstPort == 3306 {
		proto = "DATABASE"
	} else if raw.DstPort == 6379 {
		proto = "REDIS"
	} else if raw.DstPort == 9092 {
		proto = "KAFKA"
	}

	evtType := EventTypeConnect
	if raw.Type == 2 {
		evtType = EventTypeAccept
	} else if raw.Type == 3 {
		evtType = EventTypeClose
	}

	idData := fmt.Sprintf("%s-%s-%d-%s-%d-%d", e.nodeName, srcIP.String(), raw.SrcPort, dstIP.String(), raw.DstPort, raw.TimestampNs)
	hash := sha256.Sum256([]byte(idData))

	return &EnrichedEvent{
		ID:         hex.EncodeToString(hash[:8]),
		Type:       evtType,
		Timestamp:  time.Now().UTC(),
		NodeName:   e.nodeName,
		Protocol:   proto,
		Source:     srcEndpoint,
		Dest:       dstEndpoint,
		DurationNs: raw.DurationNs,
		BytesSent:  raw.BytesSent,
		BytesRecv:  raw.BytesRecv,
	}
}

func (e *MetadataEnricher) EnrichDNS(raw *RawBpfDnsEvent) *EnrichedEvent {
	clientIP := intToIP(raw.ClientIP)
	serverIP := intToIP(raw.ServerIP)
	query := cStringToString(raw.Query[:])

	clientPod := e.podCache.GetPodByIP(clientIP.String())
	clientEndpoint := Endpoint{
		IP:    clientIP,
		PID:   raw.PID,
		NetNS: raw.NetNS,
	}
	if clientPod != nil {
		clientEndpoint.PodName = clientPod.Name
		clientEndpoint.Namespace = clientPod.Namespace
		clientEndpoint.Service = clientPod.Name
	} else {
		clientEndpoint.Namespace = "default"
		clientEndpoint.Service = "client"
	}

	serverEndpoint := Endpoint{
		IP:           serverIP,
		Port:         53,
		Service:      "kube-dns",
		Namespace:    "kube-system",
		WorkloadKind: "Service",
	}

	return &EnrichedEvent{
		ID:        fmt.Sprintf("dns-%d", raw.TimestampNs),
		Type:      EventTypeDNSQuery,
		Timestamp: time.Now().UTC(),
		NodeName:  e.nodeName,
		Protocol:  "DNS",
		Source:    clientEndpoint,
		Dest:      serverEndpoint,
		DNSQuery:  query,
	}
}
