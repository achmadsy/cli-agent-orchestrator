// Package rescue provides the out-of-band recovery path for a wedged tmux
// server. Every normal webui operation is a tmux client call, so a server
// stuck in a busy-loop (e.g. a re-entrant hook chain) takes the whole UI down
// with it: each call blocks until timeout. This package never asks the server
// for state — it discovers the server process via ps, samples stack traces,
// and kills by PID — so it works exactly when tmux itself does not.
//
// Escalation ladder (mirrors the field-tested SOP): collect evidence first,
// then kill stuck hook children, and only force-kill the server + clean its
// socket as the last step.
package rescue

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

const defaultProbeTimeout = 2 * time.Second

// Proc is one row of the ps snapshot.
type Proc struct {
	PID     int     `json:"pid"`
	PPID    int     `json:"ppid"`
	TTY     string  `json:"tty"`
	CPU     float64 `json:"cpu"`
	Etime   string  `json:"etime"`
	Command string  `json:"command"`
}

// hasTTY reports whether the ps tty column names a real terminal ("??" on
// macOS / "?" on Linux mean none). This is the discriminator between pane
// shells (pty-attached, must NOT be touched by the hook-kill rung) and hook
// scripts spawned by the server's event loop (tty-less).
func (p Proc) hasTTY() bool {
	return strings.Trim(p.TTY, "?") != ""
}

// Status is the out-of-band health picture returned by Probe.
type Status struct {
	Tmux         string `json:"tmux"` // ok | no_server | wedged | error
	Detail       string `json:"detail,omitempty"`
	Servers      []Proc `json:"servers"`
	HookChildren []Proc `json:"hook_children"`
	SocketDir    string `json:"socket_dir"`
	SocketExists bool   `json:"socket_exists"`
	// InsideTmux warns that this webui process itself lives in a tmux pane:
	// force-killing the server would take the webui down with it.
	InsideTmux bool `json:"inside_tmux"`
}

// Evidence is a diagnose run: the full text plus where it was persisted.
type Evidence struct {
	Path string `json:"path,omitempty"`
	Text string `json:"text"`
}

// KillReport describes what a kill action actually did.
type KillReport struct {
	Killed        []Proc `json:"killed"`
	SocketRemoved bool   `json:"socket_removed,omitempty"`
	After         Status `json:"after"`
}

// Rescuer performs the out-of-band operations. The exec/kill seams are
// injectable so tests never touch real processes.
type Rescuer struct {
	bin          string // tmux executable, for the abandonable probe
	evidenceDir  string
	probeTimeout time.Duration

	mu      sync.Mutex
	probing bool // a probe client is still out — itself evidence of a wedge

	psFn     func(ctx context.Context) (string, error)
	sampleFn func(ctx context.Context, pid int) (string, error)
	killFn   func(pid int, sig syscall.Signal) error
}

func New(tx *tmuxctl.Client) *Rescuer {
	cache, _ := os.UserCacheDir()
	r := &Rescuer{
		bin:          tx.Binary(),
		evidenceDir:  filepath.Join(cache, "tmux-webui", "rescue"),
		probeTimeout: defaultProbeTimeout,
	}
	r.psFn = runPS
	r.sampleFn = r.runSample
	r.killFn = syscall.Kill
	return r
}

// Probe classifies tmux health without trusting the server: a short-deadline
// client call gives responsiveness, ps gives the process picture.
func (r *Rescuer) Probe(ctx context.Context) Status {
	st := Status{
		SocketDir:  SocketDir(),
		InsideTmux: os.Getenv("TMUX") != "",
		// json arrays, not null, so the frontend can iterate unconditionally
		Servers:      []Proc{},
		HookChildren: []Proc{},
	}
	if _, err := os.Stat(st.SocketDir); err == nil {
		st.SocketExists = true
	}

	st.Tmux, st.Detail = r.probeTmux(ctx)

	if out, perr := r.psFn(ctx); perr == nil {
		procs := parsePS(out)
		st.Servers = serverCandidates(procs)
		for _, s := range st.Servers {
			st.HookChildren = append(st.HookChildren, hookChildrenOf(procs, s.PID)...)
		}
	}
	return st
}

// probeTmux runs one `tmux list-sessions` as an ABANDONABLE process. It must
// not use the blocking exec path: when the server is truly stuck, its socket
// backlog fills with earlier clients (the Monitor keeps trying every few
// seconds) and a fresh client can sit in an uninterruptible connect() where
// even SIGKILL is deferred — observed live, it dragged the whole handler past
// 15s. So: Start, wait up to probeTimeout, then fire-and-forget a kill and
// answer "wedged" immediately. A reaper goroutine clears r.probing whenever
// the client finally dies; until then every new probe short-circuits — the
// still-blocked previous client IS the wedge evidence, at zero extra cost.
func (r *Rescuer) probeTmux(ctx context.Context) (state, detail string) {
	r.mu.Lock()
	if r.probing {
		r.mu.Unlock()
		return "wedged", "previous probe client still blocked — server is not draining its socket"
	}
	r.probing = true
	r.mu.Unlock()
	release := func() { r.mu.Lock(); r.probing = false; r.mu.Unlock() }

	cmd := exec.Command(r.bin, "list-sessions")
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		release()
		return "error", "tmux: " + err.Error()
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait(); release() }()

	t := time.NewTimer(r.probeTimeout)
	defer t.Stop()
	select {
	case err := <-done:
		return classify(err, stderr.String())
	case <-t.C:
	case <-ctx.Done():
	}
	_ = cmd.Process.Kill()
	return "wedged", "tmux client gave no answer — server holds the socket but does not serve it"
}

// classify maps a COMPLETED probe run to a state (timeouts never get here).
func classify(err error, stderr string) (state, detail string) {
	switch {
	case err == nil:
		return "ok", ""
	case strings.Contains(stderr, "no server running"),
		strings.Contains(stderr, "error connecting to"):
		// "error connecting to <sock>" = stale socket left by a dead server;
		// same recovery as no_server (clean the socket, start fresh).
		return "no_server", strings.TrimSpace(stderr)
	default:
		if d := strings.TrimSpace(stderr); d != "" {
			return "error", d
		}
		return "error", err.Error()
	}
}

// Diagnose collects the evidence bundle: probe status, the tmux slice of ps,
// and (macOS) a stack sample of each server candidate. Persisted best-effort
// under the cache dir so it survives the rescue that usually follows.
func (r *Rescuer) Diagnose(ctx context.Context) Evidence {
	var b strings.Builder
	fmt.Fprintf(&b, "# tmux rescue evidence — %s\n\n", time.Now().Format(time.RFC3339))

	st := r.Probe(ctx)
	fmt.Fprintf(&b, "## probe\nstate=%s detail=%q inside_tmux=%v\nsocket_dir=%s exists=%v\n\n",
		st.Tmux, st.Detail, st.InsideTmux, st.SocketDir, st.SocketExists)

	if out, err := r.psFn(ctx); err == nil {
		fmt.Fprintf(&b, "## ps (tmux processes)\n%s\n", tmuxSlice(out))
	} else {
		fmt.Fprintf(&b, "## ps failed: %v\n", err)
	}

	for _, s := range st.Servers {
		fmt.Fprintf(&b, "\n## stack sample — server pid %d (cpu %.1f%%, up %s)\n", s.PID, s.CPU, s.Etime)
		if out, err := r.sampleFn(ctx, s.PID); err == nil {
			b.WriteString(out)
		} else {
			fmt.Fprintf(&b, "(sample unavailable: %v)\n", err)
		}
	}

	ev := Evidence{Text: b.String()}
	if err := os.MkdirAll(r.evidenceDir, 0o755); err == nil {
		p := filepath.Join(r.evidenceDir, fmt.Sprintf("evidence-%d.txt", time.Now().Unix()))
		if os.WriteFile(p, []byte(ev.Text), 0o644) == nil {
			ev.Path = p
		}
	}
	return ev
}

// KillHooks terminates the TTY-LESS direct children of every tmux server
// candidate — the stuck hook scripts that keep the server's event loop
// spinning. Pane shells are also direct children of the server but sit on a
// pty, so hasTTY excludes them (killing those would destroy every session's
// running programs — verified live: a healthy server showed 14 pane shells as
// direct children). TERM first, then KILL for survivors.
func (r *Rescuer) KillHooks(ctx context.Context) (KillReport, error) {
	procs, servers, hooks, err := r.discover(ctx)
	if err != nil {
		return KillReport{}, err
	}
	_ = procs
	if len(servers) == 0 && len(hooks) == 0 {
		return KillReport{Killed: []Proc{}, After: r.Probe(ctx)}, nil
	}
	for _, h := range hooks {
		_ = r.signal(h.PID, syscall.SIGTERM)
	}
	sleepCtx(ctx, time.Second)
	// Re-scan: whoever ignored TERM gets KILL.
	if out, perr := r.psFn(ctx); perr == nil {
		alive := map[int]bool{}
		for _, p := range parsePS(out) {
			alive[p.PID] = true
		}
		for _, h := range hooks {
			if alive[h.PID] {
				_ = r.signal(h.PID, syscall.SIGKILL)
			}
		}
	}
	return KillReport{Killed: hooks, After: r.Probe(ctx)}, nil
}

// KillServer is the last rung: SIGKILL every server candidate (hook children
// first), wait for them to disappear, then remove the socket dir so the next
// tmux invocation starts a clean server. Pane shells are deliberately NOT
// signalled — closing the server tears down their ptys, which is how a manual
// `pkill -9 tmux` ends them too. Refuses to clean the socket while a
// candidate is still alive — a live server owning a removed socket is a worse
// state than the one we started in.
func (r *Rescuer) KillServer(ctx context.Context) (KillReport, error) {
	_, servers, hooks, err := r.discover(ctx)
	if err != nil {
		return KillReport{}, err
	}
	targets := append(append([]Proc{}, hooks...), servers...)
	for _, t := range targets {
		_ = r.signal(t.PID, syscall.SIGKILL)
	}

	deadline := time.Now().Add(3 * time.Second)
	for len(servers) > 0 && time.Now().Before(deadline) {
		sleepCtx(ctx, 200*time.Millisecond)
		out, perr := r.psFn(ctx)
		if perr != nil {
			continue
		}
		alive := map[int]bool{}
		for _, p := range parsePS(out) {
			alive[p.PID] = true
		}
		gone := true
		for _, s := range servers {
			if alive[s.PID] {
				gone = false
			}
		}
		if gone {
			break
		}
	}
	if out, perr := r.psFn(ctx); perr == nil {
		alive := map[int]bool{}
		for _, p := range parsePS(out) {
			alive[p.PID] = true
		}
		for _, s := range servers {
			if alive[s.PID] {
				return KillReport{Killed: []Proc{}, After: r.Probe(ctx)},
					fmt.Errorf("server pid %d survived SIGKILL; socket left untouched", s.PID)
			}
		}
	}

	rep := KillReport{Killed: targets}
	if sock := SocketDir(); sock != "" {
		if err := os.RemoveAll(sock); err == nil {
			rep.SocketRemoved = true
		}
	}
	rep.After = r.Probe(ctx)
	return rep, nil
}

func (r *Rescuer) discover(ctx context.Context) (procs, servers, hooks []Proc, err error) {
	out, err := r.psFn(ctx)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("ps: %w", err)
	}
	procs = parsePS(out)
	servers = serverCandidates(procs)
	for _, s := range servers {
		hooks = append(hooks, hookChildrenOf(procs, s.PID)...)
	}
	return procs, servers, hooks, nil
}

// signal guards against ever signalling init, process groups, or ourselves —
// the discovery is ps-text based, and a parse bug must not become a kill bug.
func (r *Rescuer) signal(pid int, sig syscall.Signal) error {
	if pid <= 1 || pid == os.Getpid() {
		return fmt.Errorf("refusing to signal pid %d", pid)
	}
	return r.killFn(pid, sig)
}

// SocketDir returns the directory tmux keeps its sockets in for this user
// (TMUX_TMPDIR override respected, /tmp default — same rules as tmux.1).
func SocketDir() string {
	base := os.Getenv("TMUX_TMPDIR")
	if base == "" {
		base = "/tmp"
	}
	return filepath.Join(base, fmt.Sprintf("tmux-%d", os.Getuid()))
}

// parsePS parses `ps -axo pid=,ppid=,tty=,pcpu=,etime=,command=` output.
func parsePS(out string) []Proc {
	var procs []Proc
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 6 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil {
			continue
		}
		cpu, _ := strconv.ParseFloat(f[3], 64)
		procs = append(procs, Proc{
			PID:     pid,
			PPID:    ppid,
			TTY:     f[2],
			CPU:     cpu,
			Etime:   f[4],
			Command: strings.Join(f[5:], " "),
		})
	}
	return procs
}

// serverCandidates picks tmux SERVER processes: argv0 basename exactly
// "tmux" (excludes tmux-webui itself) and reparented to pid 1 (the server
// daemonizes; clients stay children of whoever spawned them).
func serverCandidates(procs []Proc) []Proc {
	var out []Proc
	for _, p := range procs {
		if p.PPID != 1 {
			continue
		}
		f := strings.Fields(p.Command)
		if len(f) == 0 {
			continue
		}
		if filepath.Base(f[0]) == "tmux" {
			out = append(out, p)
		}
	}
	return out
}

func childrenOf(procs []Proc, pid int) []Proc {
	var out []Proc
	for _, p := range procs {
		if p.PPID == pid {
			out = append(out, p)
		}
	}
	return out
}

// hookChildrenOf returns the server's tty-less children only — hook scripts,
// never pane shells (see KillHooks).
func hookChildrenOf(procs []Proc, pid int) []Proc {
	var out []Proc
	for _, p := range childrenOf(procs, pid) {
		if !p.hasTTY() {
			out = append(out, p)
		}
	}
	return out
}

// tmuxSlice filters a ps dump down to tmux-related lines for the evidence
// file (full dumps are noise and can leak unrelated command lines).
func tmuxSlice(out string) string {
	var b strings.Builder
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "tmux") {
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func runPS(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,ppid=,tty=,pcpu=,etime=,command=").Output()
	return string(out), err
}

// runSample captures a 1-second stack sample of pid (macOS `sample` tool).
// The report goes to a temp file because sample mixes progress chatter into
// stdout otherwise.
func (r *Rescuer) runSample(ctx context.Context, pid int) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("stack sampling only wired for macOS")
	}
	if err := os.MkdirAll(r.evidenceDir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(r.evidenceDir, "sample-*.txt")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)

	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "sample", strconv.Itoa(pid), "1", "-f", tmpPath).CombinedOutput(); err != nil {
		return "", fmt.Errorf("sample: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// sleepCtx sleeps d but returns early if ctx is done.
func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
