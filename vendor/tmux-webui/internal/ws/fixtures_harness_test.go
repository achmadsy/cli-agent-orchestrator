package ws

// Report-only fixture harness for adversarial verification: point
// CLASSIFY_FIXTURES at a JSON file of cases and this test prints one JSON
// result line per case (state + matched rule + agent gate), asserting nothing.
// Reviewers compare the printed behavior against their expectations — the
// REAL function runs, no one argues from imagination.
//
//	CLASSIFY_FIXTURES=/path/cases.json go test ./internal/ws/ -run TestClassifyFixtures -v
//
// Case schema: [{"name": "...", "text": "...", "title": "...", "cmd": "..."}]
// (title/cmd optional; cmd defaults to "claude" so the agent gate passes.)

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

type fixtureCase struct {
	Name  string `json:"name"`
	Text  string `json:"text"`
	Title string `json:"title"`
	Cmd   string `json:"cmd"`
}

func TestClassifyFixtures(t *testing.T) {
	path := os.Getenv("CLASSIFY_FIXTURES")
	if path == "" {
		t.Skip("CLASSIFY_FIXTURES not set — adversarial harness only")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var cases []fixtureCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}
	for _, c := range cases {
		cmd := c.Cmd
		if cmd == "" {
			cmd = "claude"
		}
		agent := isAgentCommand(cmd)
		state, rule := "unknown", ""
		visIdle, skip := false, false
		if agent {
			det := classifyPane(stripAnsi(c.Text), c.Title, cmd)
			if det.rule == "" {
				det.state = "idle"
				det.rule = "default_idle"
			}
			state, rule, visIdle, skip = det.state, det.rule, det.visibleIdle, det.skip
		} else if isAgentHostCommand(cmd) {
			det := classifyTitleOnly(c.Title)
			state, rule, visIdle = det.state, det.rule, det.visibleIdle
		}
		out, _ := json.Marshal(map[string]any{
			"name": c.Name, "agent": agent, "state": state, "rule": rule,
			"visible_idle": visIdle, "skip": skip,
		})
		fmt.Printf("FIXTURE %s\n", out)
	}
}
