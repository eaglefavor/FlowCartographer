# FlowCartographer eBPF Programs Makefile
CLANG ?= clang
LLVM_STRIP ?= llvm-strip
ARCH ?= $(shell uname -m | sed 's/x86_64/x86/' | sed 's/aarch64/arm64/')
CFLAGS ?= -g -O2 -target bpf -D__TARGET_ARCH_$(ARCH) -I/usr/include/$(shell uname -m)-linux-gnu -I.

BPF_SRCS := $(wildcard *.bpf.c)
BPF_OBJS := $(BPF_SRCS:.bpf.c=.bpf.o)

.PHONY: all clean

all: $(BPF_OBJS)

%.bpf.o: %.bpf.c flow_cartographer.h
	@echo "Compiling eBPF program $< -> $@"
	$(CLANG) $(CFLAGS) -c $< -o $@
	$(LLVM_STRIP) -g $@

clean:
	rm -f *.bpf.o
