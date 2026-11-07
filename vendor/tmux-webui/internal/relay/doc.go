// Package relay implements optional pane-pool dispatch for the /api/relay
// endpoint. Wraps two Workshop-shipped bash scripts (pane_pool.sh /
// relay.sh from ~/.claude/skills/tmux-relay/scripts/) so the WebUI can hand
// long-running tasks off to a dedicated relay pane.
//
// Disabled by default: when config.relay.{pane_pool_script, relay_script}
// are both empty, the /api/relay endpoint returns 501 Not Implemented.
//
// Workshop dogfood enables relay by pointing the two paths at the bash
// scripts under ~/.claude/skills/tmux-relay/scripts/. Public OSS users
// who don't have those scripts simply leave the config blank.
package relay
