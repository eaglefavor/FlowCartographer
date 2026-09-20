// SPDX-License-Identifier: GPL-2.0 OR BSD-3-Clause
/* FlowCartographer: eBPF DNS UDP Query Interceptor */

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

struct dns_hdr_t {
    __u16 id;
    __u16 flags;
    __u16 qdcount;
    __u16 ancount;
    __u16 nscount;
    __u16 arcount;
};

SEC("kprobe/udp_sendmsg")
int BPF_KPROBE(kprobe_udp_sendmsg, struct sock *sk, struct msghdr *msg, size_t len)
{
    if (!sk || !msg)
        return 0;

    __u16 dport = 0;
    BPF_CORE_READ_INTO(&dport, sk, __sk_common.skc_dport);
    dport = __builtin_bswap16(dport);

    // Only inspect DNS traffic directed to port 53
    if (dport != 53)
        return 0;

    __u32 saddr = 0, daddr = 0;
    BPF_CORE_READ_INTO(&saddr, sk, __sk_common.skc_rcv_saddr);
    BPF_CORE_READ_INTO(&daddr, sk, __sk_common.skc_daddr);

    __u32 netns = 0;
    struct net *net = BPF_CORE_READ(sk, __sk_common.skc_net.net);
    if (net)
        BPF_CORE_READ_INTO(&netns, net, ns.inum);

    struct dns_event_t *event = bpf_ringbuf_reserve(&flow_events, sizeof(*event), 0);
    if (!event)
        return 0;

    event->type = EVENT_TYPE_DNS_QUERY;
    event->client_ip = saddr;
    event->server_ip = daddr;
    event->pid = bpf_get_current_pid_tgid() >> 32;
    event->netns = netns;
    event->timestamp_ns = bpf_ktime_get_ns();

    // Safely copy query payload if available in msghdr iov
    struct iov_iter *iter = BPF_CORE_READ(msg, msg_iter);
    if (iter) {
        const struct iovec *iov = BPF_CORE_READ(iter, iov);
        if (iov) {
            void *base = BPF_CORE_READ(iov, iov_base);
            if (base && len > sizeof(struct dns_hdr_t)) {
                // Parse QNAME following 12-byte DNS header
                bpf_probe_read_kernel_str(&event->query, sizeof(event->query), (char *)base + sizeof(struct dns_hdr_t));
            }
        }
    }

    bpf_ringbuf_submit(event, 0);
    return 0;
}
