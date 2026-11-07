package autocomplete

import "context"

// BuiltinScanner emits the curated list of Claude Code built-in slash commands
// — the universally available commands a user can type at any session (not
// loaded from disk, not user-defined). The list is hard-coded because Claude
// Code does not currently expose a discovery API.
//
// Last verified: claude-code 1.x @ 2026-05-16 against
// https://code.claude.com/docs/en/commands. When upgrading Claude Code,
// cross-check that page and bump the date above. Entries marked
// "[bundled skill]" come from the same docs page (the "Skill" rows in the
// commands table) — they live inside the CLI rather than in
// ~/.claude/skills, but they are typed and displayed the same way.
//
// Aliases listed only in a command's description (e.g. /quit for /exit,
// /bashes for /tasks) are intentionally omitted unless they appear as a
// standalone row in the docs table — the goal is to mirror the published
// "/ menu" surface, not every alternative spelling.
type BuiltinScanner struct{}

// NewBuiltinScanner returns a scanner that always yields the built-in slash
// command roster.
func NewBuiltinScanner() *BuiltinScanner { return &BuiltinScanner{} }

type builtinCmd struct {
	name string // without leading "/"
	desc string
}

var builtinSlashCommands = []builtinCmd{
	{"add-dir", "Add a working directory for file access during the session"},
	{"agents", "Manage subagent configurations"},
	{"autofix-pr", "Spawn a web session that watches the PR and pushes CI/review fixes"},
	{"background", "Detach the current session to run as a background agent (alias /bg)"},
	{"batch", "[bundled skill] Decompose a large change into 5-30 units and run each in its own worktree"},
	{"branch", "Branch the current conversation at this point (alias /fork)"},
	{"btw", "Ask a quick side question without adding to the conversation"},
	{"chrome", "Configure Claude in Chrome settings"},
	{"claude-api", "[bundled skill] Load Claude API reference for your language; also handles model migrations"},
	{"clear", "Start a new conversation with empty context (aliases /reset /new)"},
	{"color", "Set the prompt bar color for the current session"},
	{"compact", "Free up context by summarizing the conversation so far"},
	{"config", "Open the Settings interface (alias /settings)"},
	{"context", "Visualize current context usage as a colored grid"},
	{"copy", "Copy the last assistant response to clipboard"},
	{"cost", "Alias for /usage"},
	{"debug", "[bundled skill] Enable debug logging and troubleshoot session issues"},
	{"desktop", "Continue the current session in the Claude Code Desktop app (alias /app)"},
	{"diff", "Open an interactive diff viewer for uncommitted changes and per-turn diffs"},
	{"doctor", "Diagnose and verify your Claude Code installation and settings"},
	{"effort", "Set the model effort level (low/medium/high/xhigh/max/auto)"},
	{"exit", "Exit the CLI (alias /quit)"},
	{"export", "Export the current conversation as plain text"},
	{"extra-usage", "Configure extra usage to keep working when rate limits are hit"},
	{"fast", "Toggle fast mode on or off"},
	{"feedback", "Submit feedback about Claude Code (alias /bug)"},
	{"fewer-permission-prompts", "[bundled skill] Add a read-only allowlist from your transcripts"},
	{"focus", "Toggle the focus view (last prompt + final response only)"},
	{"goal", "Set a goal so Claude keeps working across turns until met"},
	{"heapdump", "Write a JavaScript heap snapshot for diagnosing high memory usage"},
	{"help", "Show help and available commands"},
	{"hooks", "View hook configurations for tool events"},
	{"ide", "Manage IDE integrations and show status"},
	{"init", "Initialize project with a CLAUDE.md guide"},
	{"insights", "Generate a report analyzing your Claude Code sessions"},
	{"install-github-app", "Set up the Claude GitHub Actions app for a repository"},
	{"install-slack-app", "Install the Claude Slack app"},
	{"keybindings", "Open or create your keybindings configuration file"},
	{"login", "Sign in to your Anthropic account"},
	{"logout", "Sign out from your Anthropic account"},
	{"loop", "[bundled skill] Run a prompt repeatedly while the session stays open"},
	{"mcp", "Manage MCP server connections and OAuth authentication"},
	{"memory", "Edit CLAUDE.md memory files and manage auto-memory"},
	{"mobile", "Show QR code to download the Claude mobile app"},
	{"model", "Select or change the AI model"},
	{"passes", "Share a free week of Claude Code with friends (if eligible)"},
	{"permissions", "Manage allow/ask/deny rules for tool permissions (alias /allowed-tools)"},
	{"plan", "Enter plan mode directly from the prompt"},
	{"plugin", "Manage Claude Code plugins"},
	{"powerup", "Discover Claude Code features through quick interactive lessons"},
	{"privacy-settings", "View and update your privacy settings (Pro/Max only)"},
	{"radio", "Open Claude FM lo-fi radio in your browser"},
	{"recap", "Generate a one-line summary of the current session on demand"},
	{"release-notes", "View the changelog in an interactive version picker"},
	{"reload-plugins", "Reload all active plugins to apply pending changes"},
	{"remote-control", "Make this session available for remote control from claude.ai (alias /rc)"},
	{"remote-env", "Configure the default remote environment for web sessions"},
	{"rename", "Rename the current session and show the name on the prompt bar"},
	{"resume", "Resume a conversation by ID or name (alias /continue)"},
	{"review", "Review a pull request locally in your current session"},
	{"rewind", "Rewind the conversation and/or code to a previous point (aliases /checkpoint /undo)"},
	{"sandbox", "Toggle sandbox mode"},
	{"schedule", "Create, update, list, or run cloud-scheduled routines (alias /routines)"},
	{"scroll-speed", "Adjust mouse wheel scroll speed interactively (fullscreen only)"},
	{"security-review", "Analyze pending changes for security vulnerabilities"},
	{"setup-bedrock", "Configure Amazon Bedrock authentication and model pins"},
	{"setup-vertex", "Configure Google Vertex AI authentication and model pins"},
	{"simplify", "[bundled skill] Review recently changed files and apply quality/efficiency fixes"},
	{"skills", "List available skills; hide a skill from Claude or the / menu"},
	{"stats", "Alias for /usage; opens on the Stats tab"},
	{"status", "Open the Settings interface (Status tab)"},
	{"statusline", "Configure the status line"},
	{"stickers", "Order Claude Code stickers"},
	{"stop", "Stop the current background session"},
	{"tasks", "List and manage background tasks (also /bashes)"},
	{"team-onboarding", "Generate a team onboarding guide from your usage history"},
	{"teleport", "Pull a Claude Code on the web session into this terminal (alias /tp)"},
	{"terminal-setup", "Configure terminal keybindings for Shift+Enter and other shortcuts"},
	{"theme", "Change the color theme"},
	{"tui", "Set the terminal UI renderer (default/fullscreen)"},
	{"ultraplan", "Draft a plan in an ultraplan session, then execute remotely or in this terminal"},
	{"ultrareview", "Run a deep, multi-agent code review in a cloud sandbox"},
	{"upgrade", "Open the upgrade page to switch to a higher plan tier"},
	{"usage", "Show session cost, plan usage limits, and activity stats"},
	{"voice", "Toggle voice dictation, or enable it in a specific mode"},
	{"web-setup", "Connect your GitHub account to Claude Code on the web"},
}

// Scan implements Scanner.
func (s *BuiltinScanner) Scan(_ context.Context) []Item {
	out := make([]Item, 0, len(builtinSlashCommands))
	for _, c := range builtinSlashCommands {
		out = append(out, Item{
			Name:        c.name,
			DisplayName: "/" + c.name,
			Description: c.desc,
			Type:        "builtin",
			Icon:        "/",
			Source:      "builtin",
		})
	}
	return out
}
