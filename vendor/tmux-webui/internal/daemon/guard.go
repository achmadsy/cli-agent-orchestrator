package daemon

import (
	"fmt"
	"net"
	"time"
)

// portGuardTimeout bounds the TCP dial probe used by GuardPort.
const portGuardTimeout = 300 * time.Millisecond

// GuardPort refuses daemon install when the configured host:port is already
// being served by something else. Without this check, installing a second
// manager for a port already owned by launchd/systemd (or Workshop's own
// workshop_services) races two processes for the same bind — a confusing
// double-manager bug to debug after the fact.
func GuardPort(host string, port int) error {
	if portListening(host, port) {
		return fmt.Errorf("port :%d already served — another manager (launchd? workshop_services?) owns this; uninstall it first", port)
	}
	return nil
}

// portListening reports whether something is already accepting TCP
// connections on host:port. A bind-all host ("0.0.0.0", "::", "") is probed
// via 127.0.0.1 — anything listening on all interfaces also answers there.
func portListening(host string, port int) bool {
	probeHost := host
	if probeHost == "" || probeHost == "0.0.0.0" || probeHost == "::" {
		probeHost = "127.0.0.1"
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(probeHost, fmt.Sprintf("%d", port)), portGuardTimeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
