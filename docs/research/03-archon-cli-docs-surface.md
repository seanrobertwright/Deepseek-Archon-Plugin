# Archon 0.10.1 — CLI & Documentation Surface (research for a DSH client plugin)

> **Purpose.** Precise catalogue of the user-facing surface of **Archon** ("command layer / workflow
> engine for AI coding agents": YAML DAG workflows mixing deterministic + AI-agent nodes, loops,
> approval gates; runs isolated in git worktrees), gathered for building a DSH (DeepSeek Harness)
> client plugin that acts as an **alternative visual layer / web UI on top of Archon**.
>
> **Provenance & method.**
> * Local checkout: `E:\Projects\deepseek harness plugins\dsh-archon\_reference\Archon` (Bun/TS monorepo,
>   root `package.json` version **0.10.1**, packages/cli 0.10.1). Read-only study of CLI sources, bundled
>   workflows and the docs source tree. No repo file was modified.
> * Web: fetched `https://archon.diy/llms.txt`, `https://archon.diy/llms-small.txt`, `https://archon.diy/roadmap/`.
> * archon.diy's `_llms-txt/<set>.txt` files and most HTML pages are **generated from the same
>   content** as the local `packages/docs-web/src/content/docs/**` markdown (`llms.txt` states: "The
>   content is automatically generated from the same source as the official documentation"), so the
>   local markdown (version 0.10.1) is used as the precise mirror of those pages. Spot checks against
>   llms-small.txt and the roadmap show the published site is effectively current with the checkout.
>   Each statement below cites the local file it came from and/or the archon.diy URL that mirrors it.
> * Keep-alive caveat for future agents: the roadmap page's milestone labels (v0.1–v0.6) are *not*
>   package versions — the checkout is already 0.10.1 and ships several "planned" roadmap items.

---

## 1. Complete CLI surface

**Entry point / binary.** The CLI is `packages/cli/src/cli.ts` (shebang `#!/usr/bin/env bun`). In dev it
runs via `bun run cli` (or `bun link` inside `packages/cli` for a global `archon`). Release binaries embed
version/commit/web-dist and `BUNDLED_IS_BINARY`; `archon serve` is binary-only. `version`/`--version`/`-V`
(and lone `-v`) print build info.

**Parsing model (args.ts + cli.ts).** A *single global* `util.parseArgs` options map
(`packages/cli/src/args.ts`) with `strict: true`; first positional = command, second = subcommand. Flags
are accepted globally then validated per command (mutual exclusions are enforced in cli.ts). Unknown flags
error before dispatch. All option specs in one place:

`--cwd <path>`, `-h/--help`, `-b/--branch <name>`, `--from`, `--from-branch`, `--base <branch>`,
`--workflow-source <path>`, `--no-worktree`, `--folder`, `--container`, `--resume`, `--adopt <run-id>`,
`--supersedes <run-id>`, `--open`, `--spawn`, `-q/--quiet`, `-v/--verbose`, `--json`, `--events`,
`--run-id`, `--type`, `--data`, `--comment`, `--reason`, `--text`, `--port <port>`, `--download-only`,
`--scope <user|install|home|project…>`, `--node <id>`, `-y/--yes`, `--force`, `--merged`,
`--include-closed`, `--conversation-id <id>`, `--detach`, `--all`, `--status <status>`, `--limit <n>`,
`--timeout <sec>`, `--follow`, `--effort <e>`, `--full`, `--dry-run`, `--stubs <path>`,
`--stubs-init <path>`, `--default-stubs`, `--exec-code`, `--pause-at-gates`, repeatable
`--input name=value`, repeatable `--model name=spec`, `--config <path>`, plus two private sealed handoffs
used by detached children (`--internal-detached-run-config`, `--internal-detached-run-id`).

**Working-directory rules.** Defaults to cwd; `--cwd` overrides. Most commands require a git repo
(found repo root is used as `effectiveCwd`); non-git dirs work when registered as *folder projects* in the
DB, or on first use via `workflow run --folder`. Exceptions that run anywhere: `version`, `help`, `setup`,
`chat`, `serve`, `skill`, `doctor`, `telemetry`, `auth`, `ai`, plus pre-git subcommands `workflow search`
and `workflow test`. A DB outage during the folder-project check surfaces "database unavailable", not a
false git error.

### Command tree (from `cli.ts` commandHelp/scopedOnlyHelp + docs `reference/cli.md`)

**`chat <message>`** — one-shot orchestrator turn: sends the message through the AI **router** (may itself
pick and start a workflow), streams response to stdout, exits. Uses `CLIAdapter({streamingMode:'batch'})`
and `handleMessage` from `@archon/core`; creates a fresh conversation each time. Multi-turn = web UI.

**`setup`** — interactive wizard (credentials/config/skill install). `--scope home` (default, writes
`~/.archon/.env`) | `--scope project` (writes `<repo>/.archon/.env`); `--force` overwrite-wholesale (backup
still written); `--spawn` opens in a new terminal window. Never writes `<cwd>/.env`. Sets `defaultAssistant`
(+ optional chat model) into `~/.archon/config.yaml`; Pi backend selection and keys; installs the
`archon-cli` skill; offers to run doctor at the end.

**`doctor [--full]`** — checklist: Claude binary spawn; Codex binary resolution (env → config → vendor →
autodetect, reports which source won); `gh` auth; Pi auth (when Pi is default); OpenCode runtime SDK
presence (`--full` always probes); DB reachability; workspace writability; bundled defaults; folder-project
detection; telemetry state; AI credential count; adapter token pings (Slack/Telegram, best-effort). Exit
0 = all pass/skip; 1 = critical failure.

**`workflow`** (all subcommands except search/test require git/folder context; most accept short 8-char run
ids resolved project-locally):
* `workflow list [name] [--full] [--json]` — discover workflows from `.archon/workflows/` (flat, one-level
  grouped, and packaged `<pack>/<workflow>/`), `~/.archon/workflows/`, bundled defaults. Compact
  descriptions (≤160 cp, truncation flagged); `--full` exact description; name resolution 4-tier:
  exact → case-insensitive → suffix → substring; ambiguous ⇒ error listing candidates. JSON:
  `{ workflows:[{…, description, descriptionTruncated}], errors:[…] }`; failure envelope
  `{ ok:false, error, errors }`.
* `workflow run <name> [msg]` — core dispatch. Options (cli.ts): `--branch/-b`, `--from/--from-branch`,
  `--base`, `--workflow-source <dir>`, `--no-worktree`, `--folder`, `--container`, `--input name=value`
  (repeat), `--model name=spec` (repeat, sparse tier/@alias rebind), `--config <path>`, `--resume`,
  `--adopt <run-id>`, `--supersedes <run-id>`, `--conversation-id <id>`, `--detach`, `--dry-run`,
  `--stubs`, `--stubs-init`, `--default-stubs`, `--exec-code`, `--pause-at-gates`. Mutually exclusive
  pairs are hard errors (`--branch`↔`--no-worktree`↔`--resume`; `--no-worktree`↔`--from/--base`;
  `--workflow-source`↔`--resume/--container`). Default isolation: auto worktree branch
  `archon/task-<workflow>-<timestamp>`; `--branch` creates/reuses a named worktree under
  `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>/`. Runs freeze their workflow source (commands,
  scripts, includes) into the run's captured source at start; resume executes the frozen source.
  Foreground `run` streams human progress; **a real `run` emits a JSON payload only with `--detach`**
  (`{ ok, runId, transcriptPath, logPath }`); `--dry-run --json` emits exactly one trace document
  (per-node resolution + `outcome` + `authoredOutcome`).
* `workflow status [--all] [--json] [--verbose] [--events]` — active (running/paused) runs for the project;
  JSON carries `scopeFallback`, `active_nodes`; `--verbose` adds per-node summary `nodes[]`.
* `workflow runs [--all] [--status <s>] [--limit <n>] [--open] [--json]` — recent runs, all statuses
  (default limit 20); `--open` = "open-work inbox" (failed runs nothing adopted/superseded).
* `workflow get <run-id> [--json] [--verbose] [--events]` — single-run detail incl. execution `status`
  (pending/running/paused/completed/failed/cancelled) **and** authored `outcome` (succeeded/failed/null);
  non-zero exit if run missing. `--events` returns raw event rows.
* `workflow logs <run-id> [--follow]` — dump the run's **JSONL transcript** verbatim on stdout; `--follow`
  waits for the file and streams until terminal. `--json` rejected (already JSONL); `--events` rejected.
* `workflow wait <run-id> [--json] [--timeout <sec>]` — block until terminal, awaiting-response (gate), or
  action-required. JSON envelope has `attention.kind`: `terminal` | `awaiting_response` | `action_required`
  | `unreadable`. Exit codes: 0 run answered; **3** = timeout while live; 1 = wait itself failed. No default
  timeout.
* `workflow resume <run-id> [--json] [--detach]` — re-execute skipping completed nodes. `--json` alone is a
  validate+ack (no inline re-execute); `--detach` inverts to a detached re-execution (`continues:true` ack).
* `workflow cancel <run-id> [--json]` — stop a live **detached** CLI run (kills owning process tree, then
  records cancelled); for foreground runs, interrupt the terminal. Fails (state unchanged) if owner
  unreachable.
* `workflow abandon <run-id> [--json]` — state-only mark cancelled (paused/orphaned runs); cascade-cancels
  non-terminal `workflow:` sub-run descendants.
* `workflow approve <run-id> [comment|--comment] [--json] [--detach]` — approve a paused gate; comment
  becomes `$LOOP_USER_INPUT`. Interactive-loop gates: no-comment approve on a completion-signaled gate
  finalizes; comment runs another iteration. JSON mode records without auto-resume; `--detach` drives
  onward in a child.
* `workflow reject <run-id> [reason|--reason] [--json] [--detach]` — reject; reason → `$REJECTION_REASON`
  (available in `on_reject` prompts).
* `workflow respond <run-id> <decision> [text] [--detach]` — resolve a gate with any *declared* decision
  (approve/reject are sugar for the commands above).
* `workflow cleanup [days]` — delete terminal run rows older than N (default 7).
* `workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes] [--json]` — clear
  persisted per-node AI sessions (persist_session memory). Cross-scope wipe requires `--yes`.
* `workflow event emit --run-id <id> --type <t> [--data <json>]` — write a workflow event row (used from
  loop prompts to record story-level lifecycle events).
* `workflow search [query]` — search the **workflow marketplace** (no git needed). No local API key needed
  (PR-based registry at archon.diy/workflows).
* `workflow install <slug> [--force]` — install a marketplace workflow into the project.
* `workflow test [<name>|<folder>|<path>]` — run declared dry-run fixtures (`fixtures/*.stubs.yaml`) for a
  workflow/folder/pack; never creates a run or contacts a provider; exec-code fixtures run in a scratch
  worktree of HEAD.

**`isolation list`** — active worktree/environment inventory grouped by codebase (branch, workflow type,
platform, days since activity).
**`isolation cleanup [days]`** — remove stale environments (default 7 days); `--merged` removes branches
merged into main (also deletes remote branches), `--include-closed` additionally removes environments whose
PRs were closed unmerged; live-run-claimable environments are never removed.

**`complete <branch> [branch2 …] [--force]`** — end-of-lifecycle: delete worktree + local + remote branch,
mark environment destroyed (verifies patches already on default remote branch first).

**`serve [--port <n>] [--download-only]`** — start the web/API server (see §4). Binary-only; downloads
`archon-web.tar.gz` from the matching GitHub release (SHA-256 verified) into `~/.archon/web-dist/<version>/`
on first run, then calls `startServer` from `@archon/server` with `webDistPath`+`port` and blocks on
SIGINT/SIGTERM.

**`skill install [path]`** — install the bundled `archon-cli` skill (SKILL.md + routing docs) into
`.claude/skills/archon-cli/` **and** `.agents/skills/archon-cli/` (Codex), overwriting; removes retired
`archon`/`manage-run` dirs. Files come from `bundled-skill.ts` (hand-maintained `with {type:'text'}`
import list; `scripts/check-bundled-skill.ts` enforces coverage).

**`auth github`** — per-user GitHub identity via device flow (GitHub App + `TOKEN_ENCRYPTION_KEY` installs);
identity from `ARCHON_USER_ID` or `$USER`/`$USERNAME`, mapped to the `cli` platform user. Tokens stored
encrypted in DB.

**`ai`** — multi-user provider credentials + model config. Credentials (auto-provisioned vault):
`ai key set <vendor>` (API key from masked prompt or **piped stdin**, never argv), `ai login <vendor>`
(anthropic / openai PKCE / github-copilot subscriptions), `ai list`, `ai logout <vendor>`. Ungated config:
`ai tier set <small|medium|large> <provider> <model> [--effort <e>] [--scope user|install]`,
`ai tier list [--json]`, `ai tier unset <tier> [--scope …]`, `ai alias set <@name> <p> <m> [--effort]`,
`ai alias list [--json]`, `ai alias unset <@name>`, `ai default <provider> [<model>] [--scope …]`.
`--scope user` writes the caller's personal prefs row (needs identity, no encryption key); install scope
writes `~/.archon/config.yaml`.

**`telemetry status` / `telemetry reset`** — show anonymous-telemetry state (enabled, opt-out reason,
install UUID, host, key source) / rotate the UUID at `~/.archon/telemetry-id`.

**`validate workflows [name] [--json]` / `validate commands [name]`** — validate YAML/DAG/refs
(commands exist, MCP configs, skills, provider compat, tier/alias model refs, static env reads) and command
.md files. Exit 0/1. Provides "did you mean?" typos.

**`version` / `--version` / `-V`** — Archon CLI vX; platform-arch, build type (binary vs source), DB type,
git commit.

**Removed:** `archon continue` (branch-name continuation) — replaced by `workflow run --adopt <run-id>`;
intercepted with a pointer message.

### Programmatic / non-interactive invocation (what a plugin should use)
* **CLI is standalone**: it *never* calls the server API — every command loads `@archon/core` in-process
  (DB: SQLite `~/.archon/archon.db` or Postgres via `DATABASE_URL`), registers providers
  (`@archon/providers` registerBuiltin+Community), and runs `executeWorkflow`/operations directly. So a CLI
  wrapper and the server are two independent windows into the same DB/state — for one shared install the
  plugin should use **one** of them consistently (both can live-run concurrently; server surfaces CLI
  detached runs via DB tail + Postgres LISTEN/NOTIFY, see §6).
* **JSON modes** that keep stdout machine-clean (all suppress logs; errors become `{ok:false, error}`):
  `workflow list/get/status/runs/wait/approve/reject/respond/cancel/abandon/resume [--json]`,
  `ai tier list --json`, `ai alias list --json`, `validate workflows --json`, `workflow run --detach
  --json` (launch ack) and `workflow run --dry-run --json` (trace doc). `workflow logs` is raw JSONL;
  `workflow event emit` writes to DB.
* **Exit codes**: 0 ok; 1 usage/command failure; `workflow wait` uses 3 for deadline; detached child reports
  its run's failure with a reserved code (`DETACHED_RUN_FAILED_EXIT_CODE`) so launchers distinguish
  "run failed" from "child died at launch".
* **Headless run of a workflow from a host:** recommended pattern per docs = `workflow run <name> --detach
  --json` (→ `runId`) then `workflow wait <run-id> --json` (blocks; returns attention) then
  `workflow get/approve/reject/resume` as needed; or plain foreground `workflow run` for interactive
  terminal use. `--json` alone on a foreground run does **not** change stdout to JSON.
* **Env boot contract** (matters when a plugin spawns `archon`): `<cwd>/.env*` keys are *stripped* at boot
  (never loaded), then `~/.archon/.env` loaded (override:true), then `<cwd>/.archon/.env` (repo scope,
  wins); `CLAUDE_USE_GLOBAL_AUTH` auto-true when no explicit Claude tokens are set.

---

## 2. Configuration reference (docs `reference/configuration.md`, `reference/database.md`, `reference/cli.md#environment`)

**Priority (later wins):** built-in defaults → `~/.archon/config.yaml` → `.archon/config.yaml` (repo) →
process env → per-user AI prefs (DB row) → run-config (sparse, one run) → explicit `--model` bindings.

**Locations.** User `~/.archon/`: `workspaces/<owner>/<repo>/{source,worktrees,artifacts,logs}`,
`workflows/`+`commands/`+`scripts/` (home-scope), `archon.db`, `config.yaml`, `.env`, `telemetry-id`,
`web-dist/<version>/`, `temp/`. Repo `.archon/`: `config.yaml`, `commands/*.md`, `workflows/*.yaml`
(or packaged `<pack>/<workflow>/` + own `commands/`,`scripts/`), `.env` (project scope).

**`~/.archon/config.yaml` shape (canonical keys):**
```yaml
defaultAssistant: claude            # registered provider id: claude|codex|pi|opencode|copilot
assistants:
  claude:
    model: sonnet
    settingSources: [project, user] # Claude SDK context-file sources
    # claudeBinaryPath: /abs/path/to/claude   # compiled binaries only
  codex:
    model: gpt-5.6-terra
    modelReasoningEffort: medium
    webSearchMode: disabled         # disabled|cached|live (Codex)
    additionalDirectories: []
    # codexBinaryPath: /abs/path/to/codex
  pi: { model: provider/model, enableExtensions: true, env: {…}, nodes: {…} }   # community
  opencode: { model: anthropic/claude-…, agent: general }                       # community
  copilot: { model: …, copilotCliPath: …, useLoggedInUser: … }                  # community
streaming: { telegram: stream, discord: batch, slack: batch, github: batch }    # stream|batch
paths: { workspaces: ~/.archon/workspaces, worktrees: ~/.archon/worktrees }
concurrency: { maxConversations: 10 }
workflows:
  autoResumeOnQuotaReset: false
  quotaFallbackDelayMs: …   # quotaMaxAttempts: 1, quotaDeadlineMs: 86400000
tiers:                      # cross-provider presets: small|medium|large
  large: { provider: claude, model: opus }
  medium: { provider: codex, model: gpt-5.6-terra, effort: high }
aliases:
  '@reasoning': { provider: claude, model: opus, effort: max }
```
Repo `.archon/config.yaml` adds: `assistant:`, `assistants.*` overrides, `commands.folder` +
`commands.autoLoad`, `worktree.baseBranch|copyFiles|initSubmodules|path|remote`,
`worktree.enabled` (pin isolation), `container.{image,network,memoryMb,pidsLimit,enabled}`,
`docs.path`, `defaults.{loadDefaultCommands,loadDefaultWorkflows}`, `recommendedWorkflows: [names]`
(UI pin order), `env:` (per-project env injected into runs; `codebase_env_vars` table via Web UI
Settings), `tiers:`/`aliases:` repo overrides. Run-scoped YAML (`workflow run --config` / HTTP inline
`config`) accepts only: `assistant`/`defaultAssistant`, `assistants`, `tiers`, `aliases`, `workflows`,
`docs.path`, `env`; other keys fail fast; unknown keys/providers fail instead of being ignored.

**Environment variables (abridged, exact table in configuration.md):** Core: `ARCHON_HOME`
(default `~/.archon`, ignored in Docker → `/.archon`), `PORT` (3090; worktrees auto-allocate 3190–4089),
`LOG_LEVEL`, `BOT_DISPLAY_NAME`, `DEFAULT_AI_ASSISTANT` (fallback provider), `MAX_CONCURRENT_CONVERSATIONS`
(10), `SESSION_RETENTION_DAYS` (30), `ARCHON_VERBOSE_BOOT`, `ARCHON_BASH_PATH` (Git-Bash autodetect on
Windows). Claude: `CLAUDE_USE_GLOBAL_AUTH`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_API_KEY`,
`TITLE_GENERATION_MODEL`, `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS`; `CLAUDE_BIN_PATH` (compiled binaries).
Codex: `CODEX_ID_TOKEN/ACCESS_TOKEN/REFRESH_TOKEN/ACCOUNT_ID`; `CODEX_BIN_PATH`. Copilot:
`COPILOT_GITHUB_TOKEN`, `COPILOT_BIN_PATH`. Adapters: `SLACK_BOT_TOKEN/APP_TOKEN/ALLOWED_USER_IDS/
STREAMING_MODE`; `TELEGRAM_BOT_TOKEN/…`; `DISCORD_BOT_TOKEN/…`; GitHub `GITHUB_TOKEN`/`GH_TOKEN`,
`WEBHOOK_SECRET`, `GITHUB_ALLOWED_USERS`, `GITHUB_BOT_MENTION`, `GITEA_*`. Multi-user GitHub:
`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `TOKEN_ENCRYPTION_KEY` (64-hex; AES-256-GCM at rest),
`ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK`, `ARCHON_WEB_AUTH_HEADER` (`X-Archon-User`). Web login (Better
Auth, Postgres-only): `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`,
`ARCHON_AUTH_ALLOWED_EMAILS`, `ARCHON_AUTH_OPEN_SIGNUP`, `ARCHON_WEB_AUTH_REQUIRED`. DB:
`DATABASE_URL` (unset ⇒ SQLite). Web UI: `WEB_UI_ORIGIN`, `WEB_UI_DEV`. Worktrees:
`STALE_THRESHOLD_DAYS` (14), `MAX_WORKTREES_PER_CODEBASE` (25), `CLEANUP_INTERVAL_HOURS` (6). Deploy:
`ARCHON_DATA`, `ARCHON_USER_HOME`, `DOMAIN`, `CADDY_BASIC_AUTH`, `AUTH_USERNAME`, `AUTH_PASSWORD_HASH`,
`COOKIE_SECRET`, `AUTH_SERVICE_PORT` (9000), `COOKIE_MAX_AGE`. Telemetry opt-out: `ARCHON_TELEMETRY_DISABLED`,
`DO_NOT_TRACK`, `CI=true`, `POSTHOG_API_KEY=off`, `POSTHOG_HOST`.

**`.env` three-path model:** `<cwd>/.env` — never loaded, keys stripped at boot (it belongs to the target
project); `~/.archon/.env` — user scope, `archon setup --scope home`; `<cwd>/.archon/.env` — project scope
overrides user, `archon setup --scope project`.

**DB config:** SQLite at `~/.archon/archon.db` (auto-created) unless `DATABASE_URL` (Postgres). Postgres
schema auto-applies `migrations/000_combined.sql` idempotently (advisory-locked); no manual migration.
18 tables prefixed `remote_agent_` (codebases, conversations, sessions, isolation_environments,
workflow_runs, workflow_events, messages, codebase_env_vars, users, user_identities,
workflow_node_sessions, user_github_tokens, user_provider_keys, user_ai_prefs + 4 Better Auth tables
`remote_agent_auth_*` — Postgres-only, only when web auth enabled). Key facts for a plugin: runs lock per
`working_path` (second dispatch auto-cancelled with message); `parent_run_id` links sub-runs; conversation
delete is **soft** only; workflow events table drives the dashboard (Postgres `LISTEN/NOTIFY` trigger,
SQLite poller). Health: `/health`, `/health/db`, `/health/concurrency`.

---

## 3. Workflow authoring model (docs `guides/authoring-workflows.md`, `guides/authoring-commands.md`, `reference/variables.md`, `reference/commands.md`)

**Layout (packaged, current):** `.archon/workflows/<pack>/<workflow>/{<workflow>.yaml, commands/*.md,
scripts/*}` — the `<pack>/<workflow>` pair is a fixed package boundary; a packaged workflow contains exactly
one YAML; bare `command:` and named `script:` resolve **only** from its own `commands/`/`scripts/` (no shared
fallback). Home scope: `~/.archon/workflows/` (overridden by same-named repo workflows). Flat
`.archon/workflows/foo.yaml`, one-level grouped YAML, and shared `.archon/commands|scripts/` are still
supported for legacy files. CLI reads from wherever you run it (sees uncommitted edits); the server reads the
workspace clone (pushed only).

**Bundled defaults:** shipped in `.archon/workflows/defaults/` (+ legacy flat YAML there and under
`defaults/legacy/`) and packaged SDLC packs under `.archon/workflows/sdlc/<phase>/` (plan/implement/
investigate/review/pr/deliver/triage/upkeep/validate/ship) plus maintainer/test/experimental packs. The
binary embeds them via `scripts/generate-bundled-defaults.ts` → `packages/workflows/src/defaults/
bundled-defaults.generated.ts` (inline string literals, sorted, CI-checked with `--check`; wired into
`bun run validate`). Runtime still loads them from disk in dev. Same-named files in `.archon/workflows/`
override bundled defaults; a repo can set `defaults.loadDefaultWorkflows:false`.

**Required workflow fields:** `name`, `description` (used by the AI router for auto-selection). Workflow-level
options: `provider`, `model` (or tier keyword `small|medium|large` or `@alias`), `effort`, `webSearchMode`
(Codex, workflow-level only), `interactive` (web foreground), `requires: [github]` (hard-block unless user's
GitHub connected — GitHub-App mode only), `worktree.enabled` (pin/force isolation off/on),
`mutates_checkout` (default true; false = skip path lock, allow side-by-side runs; advisory nodes set false),
`tags`, `inputs:` (declared signature with `default:`; caller supplies via `with:`/`--input`/API `inputs`),
`returns:` (node id whose output is the block result) + `outcome_field:` (boolean authored verdict →
run `outcome`), `deprecated: {message}`. `steps:` sequential format is removed — all DAG.

**Node model** (`guides/authoring-workflows.md#node-fields`). Exactly one body field per node:
`command` (command name; optional `with:`), `prompt` (inline AI prompt), `bash` (deterministic shell;
stdout = node output; `timeout` ms default 120000), `script` (bun TS/JS or uv Python; inline or named,
`runtime: bun|uv`, optional `deps`, `timeout`, `with:`), `loop` (iterative AI until completion), `loop_group`
(multi-node body repeated), `approval` (human gate), `wait` (durable pause to time/event/outside action),
`cancel` (terminate with reason), `include` (inline another workflow's nodes at load; namespaced; optional
`with:` and `fan_out:`), `workflow` (governed **child sub-run** at runtime — own run row/gates/artifacts/cost;
`input:` xor `with:`; `isolation: inherit|worktree`; `fan_out:`). Common fields: `id` (required),
`depends_on[]`, `when` (skip condition; `&&`/`||`, string & numeric comparisons on `$node.output[.field]` and
`$INPUTS.*`; fail-closed on parse error; whole-text comparison of *unstructured AI output* to a literal is a
load error — declare `output_format`), `trigger_rule` (`all_success` default | `one_success` |
`none_failed_min_one_success` | `all_done`; distinct from `fan_out.join` which defaults `all_done`),
`context` (`fresh` | `shared` | `{resume: node-id}` fork), `idle_timeout`, `retry`, `always_run`
(opt out of resume caching), `output_type` (typed artifact label). AI-node options: `provider`, `model`,
`output_format` (JSON Schema; enforced on Claude/Codex/OpenCode, best-effort+repair+reask×3 on Pi/Copilot;
validated post-parse for all; also certifies `bash:`/`script:` stdout), `allowed_tools`/`denied_tools` (all
except Codex), `hooks` (Claude), `mcp` (Claude/Codex/Copilot), `skills` (exact selection; Codex invokes
installed skills via `$skill-name`; OpenCode: unsupported), `agents` (inline sub-agents, Claude), `effort`
(8 rungs; clamp down on Claude/Pi/Copilot), `maxBudgetUsd`/`systemPrompt`/`fallbackModel`/`betas`/`sandbox`/
`settingSources` (Claude-only). Editable-in-builder UI list is 7 types: prompt, command, bash, script, loop,
approval, cancel.

**Commands** are `.md` files in `.archon/commands/` with YAML frontmatter `description:` (+
`argument-hint:`), body = instructions; variables `$ARGUMENTS`/`$USER_MESSAGE` (whole trigger; positional
`$1…$9` are **not** supported), `$ARTIFACTS_DIR`, `$WORKFLOW_ID`, `$BASE_BRANCH`, `$CONTEXT` (GitHub issue/PR
context, auto-appended if unused), plus `$nodeId.output` refs in DAG usage. Adapter slash commands
(`/workflow list|run|status|cancel|resume|abandon|approve|reject`, `/register-project`, `/setproject`,
`/reset`, `/help` deterministic; `/clone`, `/repos`, `/worktree …`, `/init` AI-routed) — full table in
`reference/commands.md`; the same workflow-name 4-tier resolution applies across CLI and chat surfaces.

**Variables** (`reference/variables.md`): engine vars `$ARGUMENTS/$USER_MESSAGE`, `$WORKFLOW_ID`,
`$ARTIFACTS_DIR` (`~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<id>/`), `$STATE_DIR` (project-wide
cross-run state, sibling of artifacts/logs; throws if unresolvable; no locking), `$BASE_BRANCH` (fail-fast if
unresolvable when referenced; precedence: `--base` → `worktree.baseBranch` config → codebase default branch →
git autodetect), `$DOCS_DIR` (never throws), `$CONTEXT/$EXTERNAL_CONTEXT/$ISSUE_CONTEXT`, `$LOOP_USER_INPUT`,
`$REJECTION_REASON`, `$LOOP_PREV_OUTPUT`, `$LOOP_PREV.<node>.output` (loop_group). Node refs
`$nodeId.output[.field]` require the node be a `depends_on` dependency; field refs are strict under
`output_format`. User-controlled variables are delivered to `bash:`/`script:` as **env vars**
(`ARGUMENTS`, `CONTEXT`, …) never spliced as text; `$node.output` values are auto shell-quoted in `bash:`
(>32 KB spills to `$(cat '<path>')`), raw in `script:`. Substitution order: workflow vars → context vars →
node refs. Auth clone tokens (`GH_TOKEN`, `GITLAB_TOKEN`, `GITEA_TOKEN`) are plain env.

---

## 4. Deployment topology (docs `deployment/docker.md`, `deployment/cloud.md`, `reference/architecture.md`, compose file)

**Single container is the platform.** The Docker image (`archon`, published `ghcr.io/coleam00/archon`)
runs the whole server+web (Bun `@archon/server` serving REST+SSE **and** the prebuilt static Web UI on one
port). Claude Code is pre-installed in the image with `CLAUDE_BIN_PATH` pre-set. `docker-compose.yml`
services: **`app`** (always; port `${PORT:-3000}` mapped; mounts `/.archon` ← `ARCHON_DATA` volume/host path
and `/home/appuser` ← `ARCHON_USER_HOME` for provider config), **`postgres`** (`--profile with-db`,
postgres:17-alpine, DB `remote_coding_agent`), **`caddy`** (`--profile cloud`, reverse proxy w/ automatic
HTTPS on 80/443, optional `CADDY_BASIC_AUTH`/form-auth `forward_auth`), **`auth-service`** (legacy
single-user form-auth sidecar; superseded by in-app Better Auth web login — `reference/configuration.md`
notes the Caddy forward_auth sidecar can be retired when `ARCHON_WEB_AUTH_REQUIRED` is on). Cloud-init
(`deploy/cloud-init.yml`) installs Docker+UFW, clones to `/opt/archon`, pre-pulls images, for DigitalOcean/
AWS/Linode/Hetzner/Vultr. Ports: dev `bun run dev` → web 5173 + API 3090; prod `bun run start`/Docker →
single port serving both (compose default 3000); `PORT` env overrides.

**What `archon serve` does** (binary mode): ensures web dist exists — downloads
`https://github.com/coleam00/Archon/releases/download/v<version>/archon-web.tar.gz`, verifies SHA-256
(embedded checksum constant, fallback to release `checksums.txt`), extracts to
`~/.archon/web-dist/<version>/` (atomic rename) — then `startServer({webDistPath, port})` and blocks until
SIGINT/SIGTERM. `--download-only` stops after caching. Health endpoints for ops: `/health`, `/health/db`,
`/health/concurrency`; `/api/health` reports adapter/concurrency/runningWorkflows.

**Architecture picture** (`reference/architecture.md`): platform adapters (Web/SSE+REST, Telegram, GitHub,
Slack, Discord, CLI) → **orchestrator** (`@archon/core` `handleMessage`; slash-command handler + AI router +
session lifecycle + workflow event emit) → command handler / AI-agent providers (`IAgentProvider`;
Claude Code & Codex SDKs first-party, OpenCode/Pi/Copilot community) / isolation providers
(`IIsolationProvider`: git worktree; folder projects run in place; Docker overlay for folder projects) →
SQLite/Postgres. AGENTS.md boundary notes relevant to a third-party client: adapters translate transport,
core is platform-agnostic; one install = one operator/client; DB schema is additive-only and older binaries
may open the same DB.

---

## 5. AI assistant setup matrix (docs `getting-started/ai-assistants.md`; mirrored at archon.diy)

| Provider | Kind | Install / how obtained | Auth | Binary-path config (compiled binaries) | Config keys (`assistants.<p>`) |
|---|---|---|---|---|---|
| **claude** | built-in | not bundled; native curl/ps1 installer, Homebrew, `npm i -g @anthropic-ai/claude-code`, winget | global auth `claude /login` (`CLAUDE_USE_GLOBAL_AUTH=true`) | OAuth `CLAUDE_CODE_OAUTH_TOKEN` | API key `CLAUDE_API_KEY` | `CLAUDE_BIN_PATH` env (1st) → `claudeBinaryPath` config → autodetect `~/.local/bin/claude` | `model` (sonnet/opus/haiku/inherit), `settingSources` |
| **codex** | built-in | `npm i -g @openai/codex`, brew, native binaries → `~/.archon/vendor/codex/` | `codex login`; env tokens `CODEX_ID/ACCESS/REFRESH_TOKEN`, `CODEX_ACCOUNT_ID` | `CODEX_BIN_PATH` env → `codexBinaryPath` config → vendor dir → autodetect npm-global paths | `model`, `modelReasoningEffort`, `webSearchMode`, `additionalDirectories` |
| **pi** | community (bundled, `@earendil-works/pi-coding-agent`) | included in `@archon/providers` | `~/.pi/agent/auth.json` (OAuth subs) + env API keys per ~20 backends (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ/MISTRAL/CEREBRAS/XAI/OPENROUTER…`; local LM Studio/ollama need none) | n/a (SDK) | `model: <pi-backend>/<model>`, `enableExtensions`, `extensionFlags`, `interactive`, `env`, `nodes.<id>` |
| **opencode** | community (bundled, `@opencode-ai/sdk`) | dependency of `@archon/providers` | internal; `/connect` TUI or `~/.config/opencode/opencode.json` | n/a; Archon runs an **embedded managed runtime** (no external server) | `model: <provider>/<model>` (required), `agent` |
| **copilot** | community | `github-copilot` npm CLI | `COPILOT_GITHUB_TOKEN` or logged-in GitHub | `COPILOT_BIN_PATH` env → `copilotCliPath` config | `model`, `modelReasoningEffort`, `copilotCliPath`, `configDir`, `useLoggedInUser`, `logLevel` |

Additional facts: `CLAUDE_BIN_PATH` accepts native binary, `cli.js`, or npm platform-package directory;
autodetect probes `~/.local/bin/claude` / `%USERPROFILE%\.local\bin\claude.exe`; dev mode resolves via
node_modules. `DEFAULT_AI_ASSISTANT` sets the fallback. Per-user credentials (any install): vault
auto-provisioned key at `~/.archon/credential-key` (env `TOKEN_ENCRYPTION_KEY` overrides); vendor-canonical
ids `anthropic`/`openai`/`github-copilot` (+ Pi backends); `archon ai …` and `/api/auth/providers*` manage
them. **Structured output tier:** Claude/Codex/OpenCode = enforced (grammar-constrained decode; node fails on
miss); Pi/Copilot = best-effort (schema in prompt, JSON extract+repair, up to 3 re-asks, then fail). Model
resolution layers: node → tier keyword/`@alias` → workflow → assistant config → default assistant; per-user
prefs sit above install config; only claude & codex ship built-in small/medium/large tier defaults.

---

## 6. Web UI guide essentials + third-party REST usage (docs `adapters/web.md`, `reference/api.md`)

**Web UI (built-in, no tokens/external services).** Dev: `bun run dev` (web http://localhost:5173, API 3090);
prod: single origin serving API+static UI. UI: left sidebar (conversations grouped by project, project
selector, workflow invoker), chat area (natural-language + slash commands + workflow auto-routing; streaming
AI responses with collapsible tool-call cards; lock indicator), **Command Center console** (`/console`;
also `/legacy/dashboard`) with status summary bar, run cards (status/name/elapsed/node progress), actions
(resume/cancel/abandon/approve/reject), paginated history; Settings (`/legacy/settings`) for assistant
defaults + project mgmt; execution detail at `/console/p/:projectId/r/:runId` (DAG graph, per-node logs,
artifacts, actions); **Workflow Builder** `/legacy/workflows/builder` (visual canvas, node palette, inspector,
split/code views, validation, save to `.archon/workflows/`; legacy route) and `/console/builder` (beta,
fixture-backed). Workflows run **background** by default (progress card in a worker conversation); a workflow
with `interactive: true` runs foreground (needed for approval gates/interactive loops — Approve/Reject
buttons on paused cards). Progress/result cards show active nodes, outcomes, artifacts with links; console
separates execution status from authored outcome.

**Real-time:** SSE at `/api/stream/:conversationId` (events: `text`, `tool_call`, `tool_result`,
`workflow_step`, `workflow_status`, `workflow_dispatch`, `dag_node`, `workflow_artifact`,
`conversation_lock`, `session_info`, `error`, `heartbeat`) and `/api/stream/__dashboard__` (multiplexed).
Out-of-process runs (CLI `--detach`) reach the dashboard via a DB poller on `workflow_events`
(Postgres LISTEN/NOTIFY, SQLite interval).

**REST API for third parties** (`/api/…`, Hono + OpenAPI; **no auth by default** — restrict via reverse
proxy/firewall; opt-in web auth gates `/api/*`). Machine-readable spec: `GET /api/openapi.json`.
Endpoints: conversations CRUD + `POST /{id}/message` (async dispatch; responses via SSE/poll) and
`GET /{id}/messages`; codebases CRUD + `GET /{id}/environments` (register by `url` clone or `path`);
workflows `GET /api/workflows?cwd=`, `GET /api/workflows/{name}?cwd=` (auto-discovers project→global→bundled;
`source` field), `POST /api/workflows/validate`, `PUT|DELETE /api/workflows/{name}?cwd=&source=project|global`;
runs `POST /api/workflows/{name}/run` (JSON or multipart; body fields `message`, `conversationId`,
`inputs{}` (validated vs declared inputs), `tiers{}`/`aliases{}` (per-run rebind), `config{}` inline sparse
layer; **`configPath` always rejected**), `GET /api/workflows/runs`, `GET /api/workflows/runs/{runId}`,
`GET /api/runs/{runId}/artifacts`, `GET /api/workflows/runs/by-worker/{platformId}`,
`POST .../{runId}/cancel|resume|abandon|approve|reject`, `DELETE .../{runId}`; responses carry `status`
(execution) and `outcome` (authored, nullable) as separate fields. Commands `GET /api/commands?cwd=`. Config
(ungated): `GET /api/config`, `PATCH /api/config/assistants|tiers|aliases`. Per-user AI prefs:
`GET/PATCH /api/auth/me/ai-prefs…` (identity from `X-Archon-User` header or Better Auth session). Credentials:
`GET /api/auth/providers`, `PUT|DELETE /api/auth/providers/{provider}`, OAuth
`POST .../oauth/start|poll`; never returns secrets. System: `GET /api/update-check`. Documented read of run
artifacts: `GET /api/artifacts/<run_id>/<path>` (lexical containment). Health: `/health`, `/api/health`,
`/health/db`, `/health/concurrency`.

---

## 7. Roadmap highlights (https://archon.diy/roadmap/, fetched 2026-xx)

Milestone labels are *marketing* versions, not the package version (checkout = 0.10.1). Page structure:
**◐ In progress v0.4 — Streamlined Setup & Binary Install** (self-contained binary, one-line
curl/irm installers, Homebrew formula, first-run wizard, Claude/Codex credential auto-detection — much of
this already exists in the checkout); **→ Next v0.5 — Workflow Marketplace** (archon.diy/workflows
directory, WORKFLOW.md spec, `archon workflow install <slug>` — search/install already ship in 0.10.1);
**◇ Planned v0.6 — Eval System** (`WORKFLOW.eval.yaml`, step/output correctness scoring, reliability runs,
marketplace badges, `archon workflow eval <name>`); **◇ Planned — Advanced Workflow Control Flow**
(multi-node loop bodies, branching on approval outcomes, semantic completion signals, real expression
evaluator for `when:`/`loop_until:`/`condition:`) with tracked issues; **◇ Planned — Persistent Project
Orchestrator** (stateful per-project conversation, project memory across runs, projects-first Web UI nav,
live SDK lifecycle events streamed to UI); **◇ Planned — Local LLM support** (OpenAI-compatible baseURL
config, dispatch-time model vars, bundled workflows honoring `DEFAULT_AI_ASSISTANT`); **◇ Planned —
Workflow Execution Reliability** (resumption/cache hardening, provider error-shape defenses, invariant
checks before state restore); **◇ Future** — more model providers (Copilot/Hermes), multi-repo workspace
support, enterprise GitHub App auth, production-ready deployment (Pi/VPS/Cloudflare Tunnel, hardened
Windows). **✓ Shipped v0.1** core CLI+DAG+worktrees+multi-provider; **v0.2** adapters (Slack/Telegram/
GitHub/Web/Discord/GitLab/Gitea) + Docker/cloud + Windows native; **v0.3** Pi provider + hooks/commands/
quality gates (loop nodes, approval gates, script nodes). All "shipped" items and several "planned" items
(adapters incl. Discord/GitLab/Gitea, marketplace, Copilot/OpenCode providers) exist in 0.10.1 — treat the
roadmap as directional, not a version map. GitHub issue tracker is the live source of planned work.

---

## 8. archon.diy llms.txt content map (where to look)

`https://archon.diy/llms.txt` is the index. Doc sets are concatenations served at
`https://archon.diy/_llms-txt/<set>.txt` and generated from the same source as the local tree
`packages/docs-web/src/content/docs/` (mirror below), so future agents can either fetch the URL or read the
local file. Content sets and their local mirrors:

| archon.diy set / URL | Local mirror dir | Contents |
|---|---|---|
| `llms.txt` (index), `llms-small.txt` (abridged), `llms-full.txt` (complete) | whole `docs/` tree | three granularities of the full docs |
| `quick-start.txt` (`/getting-started/*`) | `getting-started/` | overview, quick-start, concepts, configuration, installation, ai-assistants, what-archon-is-not (+ what-archon-is) |
| `the-book.txt` (`/book/*`) | `book/` | first-five-minutes, first-command, first-workflow, essential-workflows, dag-workflows, hooks-and-quality, isolation, how-it-works, quick-reference, what-is-archon |
| `guides.txt` (`/guides/*`) | `guides/` | authoring-commands, authoring-workflows, approval-nodes, loop-nodes, script-nodes, hooks, skills, mcp-servers, global-workflows, container-isolation, multi-repo-projects, remotion-workflow, index |
| `adapters.txt` (`/adapters/*`) | `adapters/` | web, slack, telegram, github, github-app-setup, index + `community/` (discord, gitlab, gitea) |
| `deployment.txt` (`/deployment/*`) | `deployment/` | docker, cloud, local, windows, e2e-testing, e2e-testing-wsl, index |
| `reference.txt` (`/reference/*`) | `reference/` | index, architecture, cli, commands, configuration, database, api, variables, provider-capabilities, archon-directories, security, troubleshooting |
| `contributing.txt` (`/contributing/*`) | `contributing/` | index, new-developer-guide, cli-internals, adding-a-community-provider, releasing, dx-quirks |
| — (site extras, not in llms sets) | — | Home `/`, `/docs/`, `/roadmap/`, `/workflows/` (marketplace) |

Other useful local anchors (repo root): `AGENTS.md` (canonical guidance; points to `reference/cli.md`,
`guides/authoring-workflows.md`, `reference/database.md`, package scripts), `CLAUDE.md`, `.archon/direction.md`,
`.archon/workflow-language-constitution.md` ("YAML coordinates. Code computes. Agents judge."), and the
bundled `archon-cli` skill sources under `.claude/skills/archon-cli/`.

---

## 9. Citations

**Fetched from archon.diy (URLs used above):**
* [https://archon.diy/llms.txt](https://archon.diy/llms.txt) — doc-set index.
* [https://archon.diy/llms-small.txt](https://archon.diy/llms-small.txt) — abridged docs (AI assistants,
  core concepts, configuration, installation, getting started, quick start, what-archon-is-not, authoring
  workflows intro; full fetched copy spilled to the session temp area by the harness).
* [https://archon.diy/roadmap/](https://archon.diy/roadmap/) — roadmap (§7).
* Per-set pages linked from llms.txt (each is the concatenation of the local mirror files listed in §8):
  [quick-start](https://archon.diy/_llms-txt/quick-start.txt),
  [the-book](https://archon.diy/_llms-txt/the-book.txt),
  [guides](https://archon.diy/_llms-txt/guides.txt),
  [adapters](https://archon.diy/_llms-txt/adapters.txt),
  [deployment](https://archon.diy/_llms-txt/deployment.txt),
  [reference](https://archon.diy/_llms-txt/reference.txt),
  [contributing](https://archon.diy/_llms-txt/contributing.txt);
  and topic pages: [Web adapter](https://archon.diy/adapters/web/),
  [Authoring workflows](https://archon.diy/guides/authoring-workflows/),
  [Architecture](https://archon.diy/reference/architecture/),
  [CLI reference](https://archon.diy/reference/cli/),
  [Configuration](https://archon.diy/reference/configuration/),
  [API](https://archon.diy/reference/api/),
  [Docker](https://archon.diy/deployment/docker/),
  [AI assistants](https://archon.diy/getting-started/ai-assistants/),
  [Database](https://archon.diy/reference/database/).

**Local repo files read (all under `E:\Projects\deepseek harness plugins\dsh-archon\_reference\Archon`):**
* CLI code: `packages/cli/src/cli.ts`, `packages/cli/src/args.ts`, `packages/cli/src/dispatch-guards.ts`,
  `packages/cli/src/bundled-skill.ts`, `packages/cli/src/commands/{version,telemetry,chat,auth,serve}.ts`
  (plus inventory of all command modules incl. workflow.ts, setup.ts, doctor.ts, ai.ts, isolation.ts,
  skill.ts, validate.ts, `adapters/cli-adapter.ts`), `scripts/generate-bundled-defaults.ts`,
  `scripts/check-bundled-skill.ts`.
* Docs: `packages/docs-web/src/content/docs/reference/{cli,commands,configuration,database,api,architecture,
  variables}.md`, `adapters/web.md`, `deployment/docker.md`,
  `guides/authoring-workflows.md` (structure + key sections), `getting-started/ai-assistants.md` (headings),
  `package.json`, `docker-compose.yml`.
* Bundled workflows: `.archon/workflows/defaults/archon-assist.yaml`,
  `.archon/workflows/sdlc/plan/archon-plan.yaml`, `.archon/workflows/sdlc/ship/archon-ship.yaml` (+ full
  inventory of `.archon/workflows/**` and `.archon/commands/defaults/*.md`).

> **Read-only compliance:** no file inside the Archon checkout was modified. Only
> `docs/research/03-archon-cli-docs-surface.md` was created (this report) under the workspace
> `docs/research/` directory.
