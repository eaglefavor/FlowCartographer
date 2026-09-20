#ifndef __FLOW_CARTOGRAPHER_H__
#define __FLOW_CARTOGRAPHER_H__

typedef unsigned char __u8;
typedef unsigned short __u16;
typedef unsigned int __u32;
typedef unsigned long long __u64;

#define COMM_LEN 16
#define DNS_NAME_MAX 128
#define PROTO_TCP 6
#define PROTO_UDP 17

#define EVENT_TYPE_CONNECT     1
#define EVENT_TYPE_ACCEPT      2
#define EVENT_TYPE_CLOSE       3
#define EVENT_TYPE_DNS_QUERY   4
#define EVENT_TYPE_EXECVE      5

// Connection flow record emitted across ring buffer
struct conn_event_t {
    __u8   type;          // EVENT_TYPE_*
    __u8   protocol;      // PROTO_TCP / PROTO_UDP
    __u16  src_port;      // Host byte order
    __u16  dst_port;      // Host byte order
    __u32  src_ip;        // IPv4 address
    __u32  dst_ip;        // IPv4 address
    __u32  pid;           // Host PID
    __u32  netns;         // Network namespace inode
    __u64  duration_ns;   // Connection duration / RTT
    __u64  bytes_sent;    // Total bytes sent
    __u64  bytes_recv;    // Total bytes received
    __u64  timestamp_ns;  // Kernel boot timestamp
    char   comm[COMM_LEN];// Process command name
};

// DNS Query event record
struct dns_event_t {
    __u8   type;          // EVENT_TYPE_DNS_QUERY
    __u8   pad[3];
    __u32  client_ip;
    __u32  server_ip;
    __u32  pid;
    __u32  netns;
    __u64  timestamp_ns;
    char   query[DNS_NAME_MAX];
};

// Process execution event record
struct exec_event_t {
    __u8   type;          // EVENT_TYPE_EXECVE
    __u8   pad[3];
    __u32  pid;
    __u32  ppid;
    __u32  netns;
    __u64  timestamp_ns;
    char   comm[COMM_LEN];
    char   filename[128];
};

// TCP connection tracking key for active state
struct conn_key_t {
    __u32 src_ip;
    __u32 dst_ip;
    __u16 src_port;
    __u16 dst_port;
};

// TCP connection state value
struct conn_state_t {
    __u64 start_time_ns;
    __u64 bytes_sent;
    __u64 bytes_recv;
    __u32 pid;
    __u32 netns;
    __u8  comm[COMM_LEN];
};

#endif // __FLOW_CARTOGRAPHER_H__
