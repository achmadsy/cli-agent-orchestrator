package rescue

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// newTestRescuer points the probe's tmux call at /usr/bin/false so tests are
// deterministic regardless of whether the host runs a real tmux server.
func newTestRescuer() *Rescuer {
	return New(tmuxctl.New(tmuxctl.WithBinary("/usr/bin/false")))
}

// psFixture mimics `ps -axo pid=,ppid=,tty=,pcpu=,etime=,command=` on a
// wedged box: one daemonized server spinning at 99.7%, one attached client,
// one stuck hook child (tty-less), two pane shells (pty-attached, must NOT
// count as hook children — macOS and Linux tty spellings), plus tmux-webui
// itself (must NOT match as a server).
const psFixture = `
  1649     1 ??      99.7 23:41 /opt/homebrew/bin/tmux
  2001  1900 ttys009  0.0 23:40 tmux attach -t main
  3123  1649 ??      12.0 05:02 /bin/zsh /Users/u/.tmux/hooks/rebalance.sh
  3200  1649 ttys003  0.0 22:10 -zsh
  3201  1649 pts/4    0.0 22:10 -bash
  4001     1 ??       0.1 01-02:03:04 /Users/u/.local/bin/tmux-webui serve
  5001  4001 ??       0.0 00:01 tmux list-sessions
`

func TestParsePSAndCandidates(t *testing.T) {
	procs := parsePS(psFixture)
	if len(procs) != 7 {
		t.Fatalf("parsePS: want 7 procs, got %d: %+v", len(procs), procs)
	}

	servers := serverCandidates(procs)
	if len(servers) != 1 || servers[0].PID != 1649 {
		t.Fatalf("serverCandidates: want exactly pid 1649, got %+v", servers)
	}
	if servers[0].CPU != 99.7 {
		t.Errorf("server CPU: want 99.7, got %v", servers[0].CPU)
	}

	if kids := childrenOf(procs, 1649); len(kids) != 3 {
		t.Fatalf("childrenOf(server): want 3 (hook + 2 pane shells), got %+v", kids)
	}
	// The kill rungs must only ever see the tty-less hook — pane shells are
	// the sessions' living processes.
	hooks := hookChildrenOf(procs, 1649)
	if len(hooks) != 1 || hooks[0].PID != 3123 {
		t.Fatalf("hookChildrenOf(server): want exactly pid 3123, got %+v", hooks)
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		stderr string
		want   string
	}{
		{"healthy", nil, "", "ok"},
		{"no server", errors.New("exit status 1"), "no server running on /tmp/tmux-501/default", "no_server"},
		{"stale socket", errors.New("exit status 1"), "error connecting to /tmp/tmux-501/default (Connection refused)", "no_server"},
		{"other", errors.New("exit status 127"), "", "error"},
	}
	for _, c := range cases {
		got, _ := classify(c.err, c.stderr)
		if got != c.want {
			t.Errorf("%s: classify = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestProbeAbandonsWedgedClient pins the fix for the observed live failure:
// under a truly wedged server the probe client never answers (and may not
// even be killable), yet Probe must still return "wedged" within its own
// timeout instead of dragging the HTTP handler along.
func TestProbeAbandonsWedgedClient(t *testing.T) {
	script := filepath.Join(t.TempDir(), "stuck-tmux")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 5\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := New(tmuxctl.New(tmuxctl.WithBinary(script)))
	r.probeTimeout = 50 * time.Millisecond
	r.psFn = func(ctx context.Context) (string, error) { return psFixture, nil }

	start := time.Now()
	st := r.Probe(context.Background())
	if st.Tmux != "wedged" {
		t.Fatalf("state: want wedged, got %q (%s)", st.Tmux, st.Detail)
	}
	if el := time.Since(start); el > time.Second {
		t.Fatalf("Probe blocked on the stuck client: took %v", el)
	}
}

func TestProbeShortCircuitsWhileClientStillBlocked(t *testing.T) {
	r := newTestRescuer()
	r.probing = true
	state, _ := r.probeTmux(context.Background())
	if state != "wedged" {
		t.Fatalf("in-flight probe: want wedged short-circuit, got %q", state)
	}
}

func TestSignalGuards(t *testing.T) {
	r := newTestRescuer()
	var killed []int
	r.killFn = func(pid int, sig syscall.Signal) error {
		killed = append(killed, pid)
		return nil
	}
	for _, pid := range []int{0, 1, -1} {
		if err := r.signal(pid, syscall.SIGKILL); err == nil {
			t.Errorf("signal(%d) should refuse", pid)
		}
	}
	if len(killed) != 0 {
		t.Fatalf("guarded pids reached killFn: %v", killed)
	}
}

func TestKillServerRequiresConfirm(t *testing.T) {
	r := newTestRescuer()
	r.killFn = func(pid int, sig syscall.Signal) error {
		t.Fatalf("killFn must not run without confirm (pid %d)", pid)
		return nil
	}

	for _, body := range []string{"", "{}", `{"confirm":false}`} {
		req := httptest.NewRequest("POST", "/api/rescue/kill-server", strings.NewReader(body))
		rec := httptest.NewRecorder()
		r.HandleKillServer(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: want 400, got %d", body, rec.Code)
		}
	}
}

func TestKillHooksTermThenKill(t *testing.T) {
	r := newTestRescuer()
	r.psFn = func(ctx context.Context) (string, error) { return psFixture, nil }

	type sent struct {
		pid int
		sig syscall.Signal
	}
	var sigs []sent
	r.killFn = func(pid int, sig syscall.Signal) error {
		sigs = append(sigs, sent{pid, sig})
		return nil
	}

	rep, err := r.KillHooks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Killed) != 1 || rep.Killed[0].PID != 3123 {
		t.Fatalf("killed: want hook 3123 only, got %+v", rep.Killed)
	}
	// Fixture keeps 3123 "alive" on the re-scan, so TERM must escalate to KILL
	// — and no other pid may ever be signalled.
	want := []sent{{3123, syscall.SIGTERM}, {3123, syscall.SIGKILL}}
	if len(sigs) != len(want) {
		t.Fatalf("signals: want %v, got %v", want, sigs)
	}
	for i := range want {
		if sigs[i] != want[i] {
			t.Fatalf("signal %d: want %v, got %v", i, want[i], sigs[i])
		}
	}
}
