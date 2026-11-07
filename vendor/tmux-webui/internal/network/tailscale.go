package network

import "net"

// HasTailscale returns true if a tailscale0 interface exists and is up.
func HasTailscale() bool {
	iface, err := net.InterfaceByName("tailscale0")
	if err != nil {
		return false
	}
	return iface.Flags&net.FlagUp != 0
}
