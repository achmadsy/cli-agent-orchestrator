package daemon

import (
	"net"
	"strconv"
	"strings"
	"testing"
)

// TestGuardPortRefusesWhenListening pins the double-manager guard: install
// must refuse when something already accepts connections on the configured
// port. This never touches ~/Library/LaunchAgents or launchctl/systemctl —
// GuardPort is a pure network probe, safe to exercise directly.
func TestGuardPortRefusesWhenListening(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	err = GuardPort("127.0.0.1", port)
	if err == nil {
		t.Fatalf("GuardPort(127.0.0.1, %d) = nil, want refusal error", port)
	}
	wantSubstr := "port :" + strconv.Itoa(port) + " already served"
	if !strings.Contains(err.Error(), wantSubstr) {
		t.Errorf("GuardPort error = %q, want substring %q", err.Error(), wantSubstr)
	}
	if !strings.Contains(err.Error(), "uninstall it first") {
		t.Errorf("GuardPort error = %q, want it to mention uninstalling first", err.Error())
	}
}

// TestGuardPortAllowsWhenFree pins the non-blocking path: a genuinely free
// port must not refuse the install.
func TestGuardPortAllowsWhenFree(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close() // free the port before probing

	if err := GuardPort("127.0.0.1", port); err != nil {
		t.Errorf("GuardPort(127.0.0.1, %d) on a free port = %v, want nil", port, err)
	}
}

// TestGuardPortNormalizesBindAllHost covers the LAN config shape
// (host="0.0.0.0"): the guard must still detect a loopback listener rather
// than dialing the literal (undialable-as-a-destination) 0.0.0.0.
func TestGuardPortNormalizesBindAllHost(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	for _, host := range []string{"0.0.0.0", "::", ""} {
		if err := GuardPort(host, port); err == nil {
			t.Errorf("GuardPort(%q, %d) = nil, want refusal (bind-all host should probe via 127.0.0.1)", host, port)
		}
	}
}
