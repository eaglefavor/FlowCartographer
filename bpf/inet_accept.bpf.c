// SPDX-License-Identifier: GPL-2.0 OR BSD-3-Clause
/* FlowCartographer: eBPF Inbound TCP Connection Probe */

#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include "flow_cartographer.h"

char LICENSE[] SEC("license") = "Dual BSD/GPL";

extern struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 16 * 1024 * 1024);
} flow_events SEC(".maps");

SEC("kretprobe/inet_accept")
int BPF_KRETPROBE(kretprobe_inet_accept, struct socket *sock)
{
    if (!sock)
        return 0;

    struct sock *sk = BPF_CORE_READ(sock, sk);
    if (!sk)
        return 0;

    __u32 saddr = 0, daddr = 0;
    __u16 sport = 0, dport = 0;

    // For accepted sockets:
    // skc_rcv_saddr is the local listener address
    // skc_daddr is the remote client address
    BPF_CORE_READ_INTO(&saddr, sk, __sk_common.skc_rcv_saddr);
    BPF_CORE_READ_INTO(&daddr, sk, __sk_common.skc_daddr);
    BPF_CORE_READ_INTO(&sport, sk, __sk_common.skc_num);
    BPF_CORE_READ_INTO(&dport, sk, __sk_common.skc_dport);
    dport = __builtin_bswap16(dport);

    if ((saddr & 0x000000FF) == 127 || (daddr & 0x000000FF) == 127)
        return 0;

    __u32 netns = 0;
    struct net *net = BPF_CORE_READ(sk, __sk_common.skc_net.net);
    if (net)
        BPF_CORE_READ_INTO(&netns, net, ns.inum);

    struct conn_event_t *event = bpf_ringbuf_reserve(&flow_events, sizeof(*event), 0);
    if (!event)
        return 0;

    event->type = EVENT_TYPE_ACCEPT;
    event->protocol = PROTO_TCP;
    // Canonical representation: src = remote client, dst = local server
    event->src_ip = daddr;
    event->src_port = dport;
    event->dst_ip = saddr;
    event->dst_port = sport;
    event->pid = bpf_get_current_pid_tgid() >> 32;
    event->netns = netns;
    event->duration_ns = 0;
    event->bytes_sent = 0;
    event->bytes_recv = 0;
    event->timestamp_ns = bpf_ktime_get_ns();
    bpf_get_current_comm(&event->comm, sizeof(event->comm));

    bpf_ringbuf_submit(event, 0);
    return 0;
}
