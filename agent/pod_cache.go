package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"
	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

type PodInfo struct {
	Name         string            `json:"name"`
	Namespace    string            `json:"namespace"`
	IP           string            `json:"ip"`
	NetNS        uint32            `json:"netns"`
	NodeName     string            `json:"nodeName"`
	WorkloadKind string            `json:"workloadKind"`
	Labels       map[string]string `json:"labels"`
	Containers   []ContainerInfo   `json:"containers"`
	ServiceRef   string            `json:"serviceRef,omitempty"`
}

type ContainerInfo struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Image string `json:"image"`
	PID   uint32 `json:"pid"`
}

type ServiceInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	ClusterIP string            `json:"clusterIP"`
	Ports     []v1.ServicePort  `json:"ports"`
	Selector  map[string]string `json:"selector"`
}

type PodCache struct {
	client      *kubernetes.Clientset
	nodeName    string
	byNetNS     map[uint32]*PodInfo
	byIP        map[string]*PodInfo
	services    map[string]*ServiceInfo // Key: IP:Port
	mu          sync.RWMutex
	informer    cache.SharedIndexInformer
	svcInformer cache.SharedIndexInformer
}

func NewPodCache(client *kubernetes.Clientset, nodeName string) *PodCache {
	pc := &PodCache{
		client:   client,
		nodeName: nodeName,
		byNetNS:  make(map[uint32]*PodInfo),
		byIP:     make(map[string]*PodInfo),
		services: make(map[string]*ServiceInfo),
	}

	if client == nil {
		logrus.Warn("Kubernetes client is nil; PodCache operating in standalone mode")
		return pc
	}

	podSelector := fields.OneTermEqualSelector("spec.nodeName", nodeName).String()
	factory := informers.NewSharedInformerFactoryWithOptions(
		client,
		30*time.Second,
		informers.WithTweakListOptions(func(opts *metav1.ListOptions) {
			opts.FieldSelector = podSelector
		}),
	)
	pc.informer = factory.Core().V1().Pods().Informer()

	svcFactory := informers.NewSharedInformerFactory(client, 60*time.Second)
	pc.svcInformer = svcFactory.Core().V1().Services().Informer()

	pc.setupEventHandlers()
	return pc
}

func (pc *PodCache) setupEventHandlers() {
	if pc.informer == nil || pc.svcInformer == nil {
		return
	}

	pc.informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			if pod, ok := obj.(*v1.Pod); ok {
				pc.syncPod(pod)
			}
		},
		UpdateFunc: func(oldObj, newObj interface{}) {
			if pod, ok := newObj.(*v1.Pod); ok {
				pc.syncPod(pod)
			}
		},
		DeleteFunc: func(obj interface{}) {
			if pod, ok := obj.(*v1.Pod); ok {
				pc.removePod(pod)
			}
		},
	})

	pc.svcInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			if svc, ok := obj.(*v1.Service); ok {
				pc.syncService(svc)
			}
		},
		UpdateFunc: func(oldObj, newObj interface{}) {
			if svc, ok := newObj.(*v1.Service); ok {
				pc.syncService(svc)
			}
		},
		DeleteFunc: func(obj interface{}) {
			if svc, ok := obj.(*v1.Service); ok {
				pc.removeService(svc)
			}
		},
	})
}

func (pc *PodCache) syncPod(pod *v1.Pod) {
	pc.mu.Lock()
	defer pc.mu.Unlock()

	workloadKind := "Deployment"
	if len(pod.OwnerReferences) > 0 {
		workloadKind = pod.OwnerReferences[0].Kind
	}

	podInfo := &PodInfo{
		Name:         pod.Name,
		Namespace:    pod.Namespace,
		IP:           pod.Status.PodIP,
		NodeName:     pod.Spec.NodeName,
		WorkloadKind: workloadKind,
		Labels:       pod.Labels,
	}

	for _, cs := range pod.Status.ContainerStatuses {
		pid := pc.resolveContainerPID(cs.ContainerID)
		podInfo.Containers = append(podInfo.Containers, ContainerInfo{
			ID:    cs.ContainerID,
			Name:  cs.Name,
			Image: cs.Image,
			PID:   pid,
		})

		if pid > 0 && podInfo.NetNS == 0 {
			if netns := pc.getNetNSInodeForPID(pid); netns > 0 {
				podInfo.NetNS = netns
			}
		}
	}

	if podInfo.IP != "" {
		pc.byIP[podInfo.IP] = podInfo
	}
	if podInfo.NetNS > 0 {
		pc.byNetNS[podInfo.NetNS] = podInfo
	}
}

func (pc *PodCache) removePod(pod *v1.Pod) {
	pc.mu.Lock()
	defer pc.mu.Unlock()

	if pod.Status.PodIP != "" {
		delete(pc.byIP, pod.Status.PodIP)
	}
	for netns, info := range pc.byNetNS {
		if info.Name == pod.Name && info.Namespace == pod.Namespace {
			delete(pc.byNetNS, netns)
		}
	}
}

func (pc *PodCache) syncService(svc *v1.Service) {
	pc.mu.Lock()
	defer pc.mu.Unlock()

	for _, port := range svc.Spec.Ports {
		key := fmt.Sprintf("%s:%d", svc.Spec.ClusterIP, port.Port)
		pc.services[key] = &ServiceInfo{
			Name:      svc.Name,
			Namespace: svc.Namespace,
			ClusterIP: svc.Spec.ClusterIP,
			Ports:     svc.Spec.Ports,
			Selector:  svc.Spec.Selector,
		}
	}
}

func (pc *PodCache) removeService(svc *v1.Service) {
	pc.mu.Lock()
	defer pc.mu.Unlock()

	for _, port := range svc.Spec.Ports {
		key := fmt.Sprintf("%s:%d", svc.Spec.ClusterIP, port.Port)
		delete(pc.services, key)
	}
}

func (pc *PodCache) getNetNSInodeForPID(pid uint32) uint32 {
	path := fmt.Sprintf("/proc/%d/ns/net", pid)
	fileInfo, err := os.Stat(path)
	if err != nil {
		return 0
	}
	stat, ok := fileInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return 0
	}
	return uint32(stat.Ino)
}

func (pc *PodCache) resolveContainerPID(containerID string) uint32 {
	// Container runtime interface (containerd/cri-o) socket inspection
	return 0
}

func (pc *PodCache) GetPodByNetNS(netns uint32) *PodInfo {
	pc.mu.RLock()
	defer pc.mu.RUnlock()
	return pc.byNetNS[netns]
}

func (pc *PodCache) GetPodByIP(ip string) *PodInfo {
	pc.mu.RLock()
	defer pc.mu.RUnlock()
	return pc.byIP[ip]
}

func (pc *PodCache) ResolveService(ip string, port uint16) *ServiceInfo {
	pc.mu.RLock()
	defer pc.mu.RUnlock()
	key := fmt.Sprintf("%s:%d", ip, port)
	return pc.services[key]
}

func (pc *PodCache) AddStaticPod(info *PodInfo) {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	if info.IP != "" {
		pc.byIP[info.IP] = info
	}
	if info.NetNS > 0 {
		pc.byNetNS[info.NetNS] = info
	}
}

func (pc *PodCache) Run(ctx context.Context) {
	if pc.informer == nil || pc.svcInformer == nil {
		<-ctx.Done()
		return
	}
	go pc.informer.Run(ctx.Done())
	go pc.svcInformer.Run(ctx.Done())
	cache.WaitForCacheSync(ctx.Done(), pc.informer.HasSynced, pc.svcInformer.HasSynced)
	logrus.Info("Pod and Service informers synchronized successfully")
	<-ctx.Done()
}
