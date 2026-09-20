// SPDX-License-Identifier: GPL-2.0 OR BSD-3-Clause
/* FlowCartographer: eBPF Process Execution & Binary Identifier */

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

struct trace_event_raw_sys_enter_execve {
    __u64 unused;
    long syscall_nr;
    const char *filename;
    const char *const *argv;
    const char *const *envp;
};

SEC("tracepoint/syscalls/sys_enter_execve")
int tracepoint_execve(struct trace_event_raw_sys_enter_execve *ctx)
{
    struct exec_event_t *event = bpf_ringbuf_reserve(&flow_events, sizeof(*event), 0);
    if (!event)
        return 0;

    __u64 pid_tgid = bpf_get_current_pid_tgid();
    event->type = EVENT_TYPE_EXECVE;
    event->pid = pid_tgid >> 32;
    event->ppid = pid_tgid & 0xFFFFFFFF;
    event->timestamp_ns = bpf_ktime_get_ns();

    bpf_get_current_comm(&event->comm, sizeof(event->comm));
    if (ctx->filename) {
        bpf_probe_read_user_str(&event->filename, sizeof(event->filename), ctx->filename);
    }

    // Network namespace identification
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    if (task) {
        struct nsproxy *nsproxy = BPF_CORE_READ(task, nsproxy);
        if (nsproxy) {
            struct net *net = BPF_CORE_READ(nsproxy, net_ns);
            if (net) {
                BPF_CORE_READ_INTO(&event->netns, net, ns.inum);
            }
        }
    }

    bpf_ringbuf_submit(event, 0);
    return 0;
}
