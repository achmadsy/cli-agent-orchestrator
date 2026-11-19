# Auto (Jev) supervisor routing

Auto routing picks a supervisor workflow ("lane") from the first prompt of a
session. You type the task, Jev classifies it through 9router's System One
endpoint, and CAO starts the matching supervisor with that prompt as its first
message. Optional per-profile routes then choose which CLI and model each
delegated worker uses, and an optional account strategy picks the provider
account with the most remaining quota.

Auto routing is off by default. A node without the `auto_routing` block in
`settings.json` behaves exactly as before.

## Lanes

| Lane profile | Use for | Budget |
|---|---|---|
| `probe_supervisor` | Questions, explanations, investigation, code reading | No edits. May use `planner` for read-only analysis. |
| `fix_supervisor` | Bug fixes, failing tests, typos, small scoped changes | `developer`, then `reviewer`. At most 1 fix pass and 1 final review. |
| `feature_supervisor` | New features and standard multi-file changes | `developer`, then `reviewer`. At most 2 fix passes. |
| `architect_supervisor` | Large, cross-cutting, or architectural changes, plus any change to auth, security, a public API, a data schema, or a destructive operation | `planner`, then user approval of the plan, then `developer` and `reviewer`. At most 2 fix passes. |

The four profiles are bundled in `agent_store/` and can also be picked by hand.
`code_supervisor` is unchanged and is not an Auto lane.

### Escalation

A lane supervisor may move itself to a heavier lane when the work turns out to
be larger than classified (for example fix to feature, or feature to
architect). It never moves to a lighter lane.

Moving from `probe_supervisor` to any editing lane is the exception. The
supervisor stops, explains what needs to change and which lane fits, and waits
for the user to confirm. Until then it does not assign or hand off work to
`developer`.

Any lane moves to `architect_supervisor` when the work turns out to touch
authentication or authorization, security boundaries or secrets, a public API,
a data schema, or a destructive or irreversible operation. The classifier's
criteria name the same triggers, so these requests usually start in Architect.

### Verification rules

The fix, feature, and architect lanes pass these rules to the developer with
every task, and ask the reviewer to check them:

- A bug fix reports its root cause with file:line evidence and adds a test or
  reproduction that fails before the fix and passes after it.
- After 3 failed fix attempts for the same bug, the developer stops and the
  supervisor moves to Architect.
- Logic changes need automated tests. Security, authentication, or data
  handling changes need a test that fails before the change.
- The reviewer reports a bug fix without root-cause evidence or a reproduction
  test as a finding.

In the Architect lane, the planner compares 2-3 approaches with trade-offs, and
the supervisor shows them to the user with the plan.

These rules and the review budgets are instructions in the profile prompts.
CAO does not enforce them in code. The supervisor's read-only tool set is
enforced: supervisors get only `cao-mcp-server`, `fs_read`, and `fs_list`.

## Configuration

Settings are per node, in `~/.aws/cli-agent-orchestrator/settings.json` (or
under `CAO_HOME_DIR`). The `lanes`, `workers`, and `custom_models` maps can
also be edited in the web UI under **Settings › Auto (Jev) defaults**. The
other keys are edited in the file only.

```json
{
  "auto_routing": {
    "enabled": true,
    "ninerouter_url": "http://127.0.0.1:20128",
    "router_model": "oc/jev-1.13-free",
    "timeout_ms": 8000,
    "min_confidence": 0.5,
    "min_margin": 0.15,
    "account_strategy": "default",
    "lanes": {
      "probe_supervisor": { "provider": "claude_code" },
      "architect_supervisor": { "provider": "claude_code", "model": "opus" }
    },
    "workers": {
      "planner": { "provider": "claude_code" },
      "developer": { "provider": "codex", "model": "gpt-5.5" },
      "reviewer": { "provider": "claude_code" }
    }
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `enabled` | `false` | Must be a JSON boolean. |
| `ninerouter_url` | `http://127.0.0.1:20128` | Must start with `http://` or `https://`. A trailing `/` is removed. |
| `router_model` | `oc/jev-1.13-free` | The 9router model used for classification. At most 256 characters. |
| `timeout_ms` | `8000` | Integer from 500 to 60000. |
| `min_confidence` | `0.5` | Number from 0 to 1. Answers below it fall back. |
| `min_margin` | `0.15` | Number from 0 to 1. When Jev reports probabilities for the other lanes, the chosen lane must lead the runner-up by at least this much. `0` turns the check off. |
| `account_strategy` | `"default"` | `"default"` or `"quota_desc"`. See [Account selection](#account-selection). |
| `lanes` | `{}` | Map of lane profile name to `{provider?, model?}`: the default CLI and model for that lane's supervisor. Only the four lane names are kept. Invalid entries are dropped one by one. See [Supervisor CLI](#supervisor-cli). |
| `workers` | `{}` | Map of agent profile name to `{provider?, model?}`. Invalid entries are dropped one by one. |
| `custom_models` | `{}` | Map of CLI name to a list of model IDs added in the Settings page, for example `{"codex": ["gpt-7"]}`. They only extend the model dropdown. Invalid IDs are dropped one by one. See [Model choices](#model-choices). |

Each key is validated on its own. An invalid value is replaced by its default
and logged, and the rest of the block still applies.

Environment variables:

| Variable | Effect |
|---|---|
| `CAO_AUTO_ROUTING_ENABLED` | Overrides `enabled`. Accepts `1/true/yes/on` and `0/false/no/off`. |
| `CAO_NINEROUTER_URL` | Overrides `ninerouter_url`. |
| `CAO_NINEROUTER_API_KEY` | Sent as `Authorization: Bearer ...` to 9router when set. It is read only from the environment, never from `settings.json`. |

Restart `cao-server` after changing the environment. `settings.json` is read
again on every Auto launch, so a change to it, including a save from the
Settings page, applies to the next Auto session without a restart. Running
sessions keep the worker routes they started with.

## Supervisor CLI

The lane supervisor's CLI is resolved in this order:

1. The provider picked in the Spawn form or sent as `provider` to the API.
2. The `lanes` default for the lane Jev chose.
3. The lane profile's own `provider`. The bundled lane profiles set none.
4. CAO's default provider (`kiro_cli`).

The lane's `model` is used when the supervisor runs on the lane's own CLI. If
the form picks a different CLI, the lane model is dropped, the same rule as
for worker routes. Without a lane model, the CLI starts with its own default
model.

In the web UI and the Fleet panel, the provider list in Auto mode starts on
**Default (from Settings)**, which sends no provider, so the lane defaults
apply. Picking a CLI there overrides them for that launch.

## Worker routes

`workers` is keyed by agent profile name (`planner`, `developer`, `reviewer`,
or any other profile), not by role. That matters because `planner` has the
`reviewer` role but can still be routed separately.

The routes are copied into the Auto session's metadata when the session is
created. When the supervisor calls `assign` or `handoff`, the provider for the
worker is resolved in this order:

1. The provider passed explicitly to the tool call.
2. The `workers` route for the worker's profile name.
3. The session's `role_providers` policy. Auto sessions do not set one.
4. The worker profile's own `provider`.
5. The supervisor's provider.

The route's `model` is used only when the call does not pass its own model. If
the call passes a different provider than the route, the route's model is
dropped, so a model is never paired with a CLI it was not written for.

Workers without a route behave as they do in any other supervisor session.

The four lane prompts hand work only to `developer`, `reviewer`, and
`planner`, so those are the routes Auto sessions normally use. The Settings
page also lists every other profile on the node, under **Other profiles**. A
route for one of them applies only when a supervisor delegates to that
profile, for example because the first prompt asks for it. A name typed into
the add field can name a profile that exists only on another Fleet node.

## Model choices

The model of each row in **Settings › Auto (Jev) defaults** is a dropdown.
It lists:

- **CLI's default model**, which sends no `--model`, so the CLI uses its own
  default.
- The built-in models for that CLI, from
  `src/cli_agent_orchestrator/services/model_catalog.py`. `claude_code` lists
  the aliases `opus`, `sonnet`, `haiku`, and `fable`, which always start the
  latest model of that family. `codex` lists the models `codex debug models`
  marks visible. Other CLIs have no built-in list because their model names
  depend on how each node configures the CLI.
- Models added by you, from `custom_models`.

**Add a model…** at the end of the list opens a field for a model ID the list
does not have, for example a model a CLI shipped after this CAO release. The
ID must be what that CLI's `--model` flag accepts. Saving stores it under
`custom_models` for that CLI, and it then appears in the dropdown of every row
on the same CLI. **Added models** under the worker list removes one. A route
that still names a removed model keeps it and shows it under **Saved**.

The lists are suggestions, not an allow-list. CAO does not check that the CLI
knows the model; a wrong ID fails when the CLI starts.

## Account selection

With `"account_strategy": "quota_desc"`, CAO picks a provider account for the
supervisor and for each worker it starts on the same node:

- Only accounts with `auth_state` `authenticated` are considered.
- Each account's quota is read, and an account's score is its lowest
  `remaining` value. The highest score wins. On a tie, a fresh reading beats a
  cached one.
- An account whose quota read fails or is not `ok` is skipped.
- Only providers whose account registry reports quota take part. `codex` and
  `opencode_cli`, for example, do not, so they always use their default config.
- The whole selection has a 5 second budget. A timeout, a store error, or no
  account with a usable quota means the default CLI config is used.

An account chosen explicitly in the spawn form always wins over the strategy.
Workers handed off to another Fleet node never get an account from this node,
because accounts are local to each node.

With no accounts configured, `quota_desc` behaves like `default`.

## Fallback

Classification never blocks a launch. When it cannot produce a usable answer,
the session starts as `feature_supervisor` and the response carries a
`fallback_reason`:

| Reason | Cause |
|---|---|
| `empty_prompt` | The prompt is blank after trimming. |
| `timeout` | 9router did not answer within `timeout_ms`. |
| `unreachable` | Connection error to `ninerouter_url`. |
| `http_<code>` | 9router answered with a non-2xx status. |
| `invalid_json` | The response body was not JSON. |
| `malformed_response`, `missing_answer` | The JSON did not contain `answers.lane`. |
| `unknown_lane` | Jev chose something other than the four lanes. |
| `missing_confidence` | The confidence was missing, not a number, or outside 0 to 1. |
| `low_confidence` | The confidence was below `min_confidence`. The value is kept. |
| `ambiguous` | The chosen lane led the runner-up by less than `min_margin`. The value is kept. |

The web UI shows the outcome in a snackbar, for example
`Jev picked fix_supervisor (82%)` or
`Jev unavailable (timeout); using feature_supervisor`.

## Privacy

The first 2000 characters of the prompt leave the node. They go to 9router,
which forwards them to the upstream of `router_model`. With the default
`oc/jev-1.13-free`, that is the free OpenCode Zen lane. Choose a different
`router_model` if the prompts must stay with a specific provider.

CAO does not log the prompt or the API key, and the prompt is not stored in
session metadata. The metadata keeps only the decision (`lane`, `confidence`,
`fallback_reason`, `router_model`), the account strategy, and the worker
routes. The prompt is still delivered to the agent, so it is stored in the
agent's [Inbox history](inbox-delivery.md#direct-input-history) in the local
CAO database, like any other input sent through CAO, and deleted after 14 days.

## Using it

**Web UI.** In Spawn Agent, the profile list shows **Auto (Jev)** at the top
when `GET /auto-routing/status` reports `enabled: true`. Picking it shows a
required **First prompt** field and hides the Delegated agent CLIs section. If
the launch fails, the dialog stays open with the prompt kept.

**Fleet panel.** The launch dialog adds an Auto (Jev) profile option for nodes
that report Auto routing as enabled. The first task is then required. Nodes
that are older or have Auto routing disabled show only the normal profiles.

**API.**

```
GET  /auto-routing/status
     -> {"enabled": bool, "router_model": str}

POST /auto-routing/sessions        (JSON body)
     {"initial_message": str,      required, not blank
      "provider": str?,            the supervisor's CLI
      "provider_profile": str?,    an explicit account, skips the strategy
      "session_name": str?,
      "working_directory": str?}
     -> 201 {"terminal": {...}, "decision": {...}}
     -> 409 when Auto routing is disabled
     -> 400 for an invalid session name, working directory, or metadata
     -> 422 for an invalid body, including any agent_profile field

GET  /agents/provider-profiles/select?provider=<name>
     -> {"profile_id": str | null}

GET  /settings/auto-routing
     -> {"enabled": bool, "lane_names": [str], "fallback_provider": str,
         "lanes": {...}, "workers": {...},
         "builtin_models": {cli: [str]}, "custom_models": {cli: [str]}}

PUT  /settings/auto-routing        (JSON body, write scope)
     {"lanes": {...}?, "workers": {...}?, "custom_models": {...}?}
     -> 200 with the same shape as GET
     -> 400 naming the first bad entry; nothing is written
     -> 503 when settings.json exists but cannot be read; it is not overwritten
```

`PUT` replaces each map it receives and leaves an omitted map unchanged. Every
other `auto_routing` key is kept. An entry with a `model` must also name a
`provider`. Model names follow the same rule as other CAO model overrides:
letters, digits, and `. _ : / -`, at most 128 characters. Each map holds at
most 32 entries. `custom_models` must name known CLIs and holds at most 50
models per CLI; IDs are trimmed and de-duplicated.

The prompt is delivered by the same create call, so there is no separate send
step. The endpoint has no idempotency key: retrying could classify the prompt
into a different lane.
