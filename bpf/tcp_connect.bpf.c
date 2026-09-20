// SPDX-License-Identifier: GPL-2.0 OR BSD-3-Clause
/* FlowCartographer: eBPF Outbound TCP Connection Probe */

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include "flow_cartographer.h"

char LICENSE[] SEC("license") = "Dual BSD/GPL";

// Ring buffer map for event dispatching to userspace
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 16 * 1024 * 1024); // 16MB ring buffer
} flow_events SEC(".maps");

// Hash map for tracking connection lifecycles and measuring RTT
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);
    __type(key, struct conn_key_t);
    __type(value, struct conn_state_t);
} active_conns SEC(".maps");

SEC("kprobe/tcp_connect")
int BPF_KPROBE(kprobe_tcp_connect, struct sock *sk)
{
    if (!sk)
        return 0;

    __u32 src_ip = 0, dst_ip = 0;
    __u16 src_port = 0, dst_port = 0;

    // Read socket addressing via BPF CO-RE helpers
    BPF_CORE_READ_INTO(&src_ip, sk, __sk_common.skc_rcv_saddr);
    BPF_CORE_READ_INTO(&dst_ip, sk, __sk_common.skc_daddr);
    BPF_CORE_READ_INTO(&src_port, sk, __sk_common.skc_num);
    BPF_CORE_READ_INTO(&dst_port, sk, __sk_common.skc_dport);
    dst_port = __builtin_bswap16(dst_port); // Convert big-endian to host order

    // Discard loopback (127.0.0.0/8) traffic to reduce noise
    if ((dst_ip & 0x000000FF) == 127 || (src_ip & 0x000000FF) == 127) {
        return 0;
    }

    // Read Network Namespace inode from socket struct
    __u32 netns = 0;
    struct net *net = BPF_CORE_READ(sk, __sk_common.skc_net.net);
    if (net) {
        BPF_CORE_READ_INTO(&netns, net, ns.inum);
    }

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u32 pid = pid_tgid >> 32;
    __u64 ts = bpf_ktime_get_ns();

    // Record in active connection map for duration calculation on close
    struct conn_key_t key = {
        .src_ip = src_ip,
        .dst_ip = dst_ip,
        .src_port = src_port,
        .dst_port = dst_port,
    };

    struct conn_state_t state = {
        .start_time_ns = ts,
        .bytes_sent = 0,
        .bytes_recv = 0,
        .pid = pid,
        .netns = netns,
    };
    bpf_get_current_comm(&state.comm, sizeof(state.comm));
    bpf_map_update_elem(&active_conns, &key, &state, BPF_ANY);

    // Reserve ring buffer slot and emit connection start event
    struct conn_event_t *event = bpf_ringbuf_reserve(&flow_events, sizeof(*event), 0);
    if (!event)
        return 0;

    event->type = EVENT_TYPE_CONNECT;
    event->protocol = PROTO_TCP;
    event->src_ip = src_ip;
    event->dst_ip = dst_ip;
    event->src_port = src_port;
    event->dst_port = dst_port;
    event->pid = pid;
    event->netns = netns;
    event->duration_ns = 0;
    event->bytes_sent = 0;
    event->bytes_recv = 0;
    event->timestamp_ns = ts;
    bpf_get_current_comm(&event->comm, sizeof(event->comm));

    bpf_ringbuf_submit(event, 0);
    return 0;
}
