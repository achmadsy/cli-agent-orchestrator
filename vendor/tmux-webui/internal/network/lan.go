// Package network provides LAN interface discovery and Tailscale detection.
package network

import (
	"net"
	"sort"
)

// LAN represents a discovered LAN network interface.
type LAN struct {
	IP          string
	Name        string
	IsTailscale bool
}

// LocalAddresses returns non-loopback IPv4 addresses, RFC1918 sorted first.
// Each entry carries the interface name and a Tailscale flag.
func LocalAddresses() []LAN {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	var results []LAN
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.To4() == nil {
				continue
			}
			results = append(results, LAN{
				IP:          ip.String(),
				Name:        iface.Name,
				IsTailscale: iface.Name == "tailscale0",
			})
		}
	}

	sort.SliceStable(results, func(i, j int) bool {
		// RFC1918 priority: 10.x, 172.16-31.x, 192.168.x
		pi := rfc1918Priority(results[i].IP)
		pj := rfc1918Priority(results[j].IP)
		return pi > pj
	})
	return results
}

// rfc1918Priority returns a priority score for RFC1918 addresses (higher = shown first).
func rfc1918Priority(ip string) int {
	parsed := net.ParseIP(ip).To4()
	if parsed == nil {
		return 0
	}
	switch {
	case parsed[0] == 10:
		return 3
	case parsed[0] == 172 && parsed[1] >= 16 && parsed[1] <= 31:
		return 2
	case parsed[0] == 192 && parsed[1] == 168:
		return 1
	default:
		return 0
	}
}
