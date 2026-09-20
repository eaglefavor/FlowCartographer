package main

import (
	"net"
	"time"
)

type EventType string

const (
	EventTypeConnect  EventType = "CONNECT"
	EventTypeAccept   EventType = "ACCEPT"
	EventTypeClose    EventType = "CLOSE"
	EventTypeDNSQuery EventType = "DNS_QUERY"
	EventTypeExecve   EventType = "EXECVE"
)

type Endpoint struct {
	PodName       string            `json:"podName,omitempty"`
	Namespace     string            `json:"namespace,omitempty"`
	WorkloadKind  string            `json:"workloadKind,omitempty"`
	Service       string            `json:"service,omitempty"`
	IP            net.IP            `json:"ip"`
	Port          uint16            `json:"port"`
	Process       string            `json:"process,omitempty"`
	PID           uint32            `json:"pid,omitempty"`
	NetNS         uint32            `json:"netns,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
}

type EnrichedEvent struct {
	ID             string    `json:"id"`
	Type           EventType `json:"type"`
	Timestamp      time.Time `json:"timestamp"`
	NodeName       string    `json:"nodeName"`
	Protocol       string    `json:"protocol"` // "TCP", "UDP", "HTTP", "gRPC"
	Source         Endpoint  `json:"source"`
	Dest           Endpoint  `json:"dest"`
	DurationNs     uint64    `json:"durationNs,omitempty"`
	BytesSent      uint64    `json:"bytesSent,omitempty"`
	BytesRecv      uint64    `json:"bytesRecv,omitempty"`
	DNSQuery       string    `json:"dnsQuery,omitempty"`
	BinaryFilename string    `json:"binaryFilename,omitempty"`
}

type RawBpfConnEvent struct {
	Type        uint8
	Protocol    uint8
	SrcPort     uint16
	DstPort     uint16
	SrcIP       uint32
	DstIP       uint32
	PID         uint32
	NetNS       uint32
	DurationNs  uint64
	BytesSent   uint64
	BytesRecv   uint64
	TimestampNs uint64
	Comm        [16]byte
}

type RawBpfDnsEvent struct {
	Type        uint8
	Pad         [3]byte
	ClientIP    uint32
	ServerIP    uint32
	PID         uint32
	NetNS       uint32
	TimestampNs uint64
	Query       [128]byte
}

type RawBpfExecEvent struct {
	Type        uint8
	Pad         [3]byte
	PID         uint32
	PPID        uint32
	NetNS       uint32
	TimestampNs uint64
	Comm        [16]byte
	Filename    [128]byte
}
