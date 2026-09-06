# Archon v0.10 — Server, Web UI, Adapters & Data Model (integration reference)

> **Scope**: external-frontend driving/observation of Archon. All paths are relative to the Archon
> checkout root (`_reference/Archon`). Evidence is given as `file:line`. This report deliberately
> avoids `core/workflows/isolation/providers` internals except to name the functions the server calls.
>
> **Reading note**: the shipped docs in `.claude/docs/architecture-deep-dive.md` and
> `adapter-implementation-guide.md` describe the *pre-v0.10* layout in places (e.g. adapters under
> `packages/adapters/src/chat/…` vs the current `community/…` split, "5 commands" etc.). The source
> below is the current evidence.

---

## 1. Server architecture summary

### 1.1 Framework & process model

- **Hono `OpenAPIHono`** (`@hono/zod-openapi`) serving all HTTP, executed by **`Bun.serve`**
  (`packages/server/src/index.ts:927-932`) with `idleTimeout: 255` so long-lived SSE sockets are not
  killed. Bun runs TypeScript directly; the Docker image ships source (no compile step,
  `Dockerfile:160`).
- **One process**. The web server, every platform adapter, the workflow-event bridge, the dashboard
  poller, the Postgres `LISTEN` bridge, and the workflow-continuation scheduler all live in one Bun
  process. Separate processes (the `archon` CLI, especially `workflow run --detach`) write to the
  same DB; the server *observes* them via a DB poller (see §3.4) rather than shared memory.
- Entry point: `startServer()` at `packages/server/src/index.ts:232`; `if (import.meta.main)` runs it
  (`index.ts:1092-1097`). `ServerOptions` allow overriding `webDistPath`, `port`, and
  `skipPlatformAdapters` (`index.ts:220-231`).

### 1.2 Boot sequence (order matters)

1. **Env loading** — strip CWD `.env` keys, load repo-root `.env` (dev), then `~/.archon/.env` +
   `<cwd>/.archon/.env` via `loadArchonEnv()` (`index.ts:6-42`).
2. **Provider registry** — `registerBuiltinProviders()` / `registerCommunityProviders()`, then
   `getVendorCatalog()` fail-fast (`index.ts:52-61`).
3. **Posture checks (fail-fast `process.exit(1)`)** — encryption key for per-user keys
   (`assertProviderKeysKeyAtBoot`, `index.ts:271`), AI credentials must exist (Claude `CLAUDE_API_KEY |
   CLAUDE_CODE_OAUTH_TOKEN | CLAUDE_USE_GLOBAL_AUTH` or Codex `CODEX_ID_TOKEN`+`CODEX_ACCESS_TOKEN`,
   `index.ts:280-314`), DB reachable (`pool.query('SELECT 1')`, `index.ts:316-323`).
4. Config load + cleanup scheduler + `ConversationLockManager(maxConcurrent)`
   (`index.ts:325-352`, `MAX_CONCURRENT_CONVERSATIONS` default 10).
5. **Web adapter stack** always constructed and started: `SSETransport` (SSE registry + replay
   buffers) → `MessagePersistence` (assistant-text buffer → DB) → `WorkflowEventBridge`
   (workflow-emitter → SSE) → `WebAdapter` facade (`index.ts:354-373`). `persistence.startPeriodicFlush()`
   flushes every 30 s.
6. **Dashboard observability**: `DashboardEventPoller` tails `remote_agent_workflow_events`
   (Postgres: poll every 10 s + `PgNotifyListener` on `archon_dashboard_event`; SQLite: poll every
   1.5 s) and replays to the `__dashboard__` SSE stream (`index.ts:375-389`).
7. **Platform adapters** (skipped when `opts.skipPlatformAdapters`), each gated on env vars —
   GitHub (App **or** PAT, conflict = fatal), Gitea, GitLab, Discord, Slack; Telegram starts *after*
   `Bun.serve` because it long-polls (`index.ts:396-676`, `935-970`). `activePlatforms[]` is mutated
   as each starts and is reported by `/api/health` (`index.ts:394`, `5041-5056`).
8. **Web auth** (opt-in Better Auth) mounted at `/api/auth/*` before API routes (`index.ts:709-731`);
   see §4.
9. **`registerApiRoutes()`** — all `/api/*` REST + SSE (`index.ts:734`; defined in
   `packages/server/src/routes/api.ts:1586`).
10. Webhook + internal routes (GitHub webhook, `/internal/git-credential`, Gitea/GitLab webhooks)
    and plain health endpoints (`index.ts:737-855`).
11. **Static web serving** (prod only) + `Bun.serve` (`index.ts:857-933`).
12. **Continuation scheduler** — every 5 s scans due paused/failed runs and resumes them through the
    owning platform adapter, a web worker conversation, or headless execution
    (`index.ts:976-1003`; `packages/server/src/services/workflow-resume-service.ts:299-318`).
13. Graceful shutdown on SIGINT/SIGTERM flushes message buffers, stops adapters, telemetry, Better
    Auth pool, DB pool (`index.ts:1006-1052`).

### 1.3 How adapters register (trigger side)

The server wires `IPlatformAdapter` instances (constructed in `packages/server/src/index.ts`) to a
shared `handleMessage()` from `@archon/core` under a per-conversation `ConversationLockManager`.
Pattern (e.g. Discord `index.ts:535-587`, Slack `index.ts:624-664`, Telegram `index.ts:943-958`):

```
env gate → new XxxAdapter(...) → adapter.onMessage(async event => {
    conversationId = adapter.getConversationId(event)         // platform-native id
    maybe ensureThread(conversationId, event)                 // Discord creates real threads
    maybe threadContext / parentConversationId from history
    userId = resolveUserId(platform, platformUserId, displayName)  // never throws (index.ts:153-175)
    lockManager.acquireLock(conversationId, () => handleMessage(adapter, conversationId, text, ctx))
}).catch(createMessageErrorHandler(...))
await adapter.start()
```

GitHub is self-contained: it is driven by `POST /webhooks/github` (`packages/server/src/routes/webhooks.ts:24`)
→ `GitHubAdapter.handleWebhook()` and manages its own lock acquisition; `start()` is a no-op
(`packages/adapters/src/forge/github/adapter.ts:467,967`). Gitea/GitLab are the same shape via
`/webhooks/gitea` (`index.ts:785`) and `/webhooks/gitlab` (`index.ts:813`).

The **Web adapter never receives inbound events** — messages arrive through REST
(`POST /api/conversations/:id/message`, `POST /api/workflows/:name/run`); it is purely output-side:
SSE streaming + message persistence (`packages/server/src/adapters/web.ts:1-4`).

### 1.4 Static web serving

When `NODE_ENV === 'production'` **or** `WEB_UI_DEV` is unset (`index.ts:859`):
`/assets/*` and `/favicon.png` from `packages/web/dist` and a final `app.get('*', serveStatic index.html)`
SPA fallback registered **after** all API routes (`index.ts:870-873`). Dev mode instead runs the Vite
dev server (port 5173) which proxies `/api` to the backend (default port **3090**);
**SSE bypasses the Vite proxy in dev** because Vite buffers SSE — the client connects straight to
`http://<host>:3090` (`packages/web/src/lib/api.ts:17-20`, `vite.config.ts:47-55`).

### 1.5 Core functions the server calls (boundary notes, not internals)

`packages/server/src/routes/api.ts` imports and calls, among others:
`handleMessage`, `getDatabaseType`, `getSchemaVersion`, `loadConfig`/`loadRepoConfig`,
`toSafeConfig`, `updateGlobalConfig`, `cloneRepository`/`registerRepository`/`registerFolder`,
`generateAndSetTitle`/`resolveTitleRequest`, per-user GitHub device flow + token store,
per-user provider-key store (encrypt/decrypt, `persistProviderApiKey`, `listConnectableVendors`,
`SUBSCRIPTION_PROVIDERS`, `startOAuth`/`pollOAuth`), `getUserAiPrefs`/`setUserTiers`/`setUserAliases`/
`setUserDefault`, `parseWorkflowRunConfig`, and workflow operations `abandonWorkflow`,
`approveWorkflow`, `rejectWorkflow`, `respondToWorkflow`, `resetWorkflowNodeSessions`
(`api.ts:24-63, 269-276`). DB access goes through the namespaced `@archon/core/db/*` modules
(`api.ts:261-268`). Webhook/runs resumes call `executeWorkflow`/`hydrateResumableRun` from
`@archon/workflows/executor` only inside `services/workflow-resume-service.ts:6-7,159`.

---

## 2. Complete REST API surface

- Base path: **`/api`** (except webhooks `/webhooks/*`, internal `/internal/*`, plain `/health*`).
- OpenAPI spec: **`GET /api/openapi.json`** (`api.ts:3261-3264`).
- Route registration helper: `registerOpenApiRoute(route, handler)` → `app.openapi(route, handler)`
  with Zod input validation via `defaultHook` (`api.ts:3242-3258`; `openapi-defaults.ts`). Response
  schemas are documentation only (output not validated).
- Error shape: `{ error: string, detail?: string }` (`api.ts:1592-1599`).
- CORS: `app.use('/api/*', cors({ origin: process.env.WEB_UI_ORIGIN || '*' }))` (`api.ts:1690`).
- Route *config* (`createRoute`, lines L₁) and *handler* (lines L₂) are separated in `api.ts`; both
  are cited below.

### 2.1 System / health / config / providers

| Method | Path | Purpose | Config / Handler |
|---|---|---|---|
| GET | `/api/health` | Health incl. lock stats, running workflows, active platforms, schema vintage. Public (bypasses auth gate) | api.ts:1527 / 5008 |
| GET | `/api/update-check` | Binary-only update check | api.ts:1566 / 5059 |
| GET | `/api/config` | Read-only safe config subset + db type | api.ts:1132 / 4839 |
| PATCH | `/api/config/assistants` | Change default assistant / per-provider settings (writes `~/.archon/config.yaml`) | api.ts:1150 / 4853 |
| PATCH | `/api/config/tiers` | Update `small/medium/large` model presets (ungated) | api.ts:1171 / 4900 |
| PATCH | `/api/config/aliases` | Update `@custom` model aliases (ungated) | api.ts:1195 / 4932 |
| GET | `/api/providers` | List registered AI providers + capabilities | api.ts:1235 / 4962 |
| GET | `/api/providers/pi/models` | Pi model catalog hint (never errors) | api.ts:1219 / 4967 |
| GET | `/api/providers/opencode/credentials` | OpenCode backend introspection (heavy; starts embedded runtime) | api.ts:1248 / 4980 |
| GET | `/health`, `/health/db`, `/health/concurrency` | Plain health endpoints (outside `/api`) | index.ts:838, 842, 852 |

### 2.2 Codebases (projects)

| Method | Path | Purpose | Config / Handler |
|---|---|---|---|
| GET | `/api/codebases` | List projects (dedup by repo URL) | api.ts:699 / 3050 |
| GET | `/api/codebases/{id}` | One project | api.ts:713 / 3080 |
| POST | `/api/codebases` | Register: `{url}` (clone) or `{path}` (local; git→repo, non-git→folder) | api.ts:729 / 3094 |
| DELETE | `/api/codebases/{id}` | Delete project + destroy worktrees + rm workspace (if Archon-managed) | api.ts:754 / 3149 |
| GET | `/api/codebases/{id}/env` | List env-var **keys** (values never returned) | api.ts:774 / 3199 |
| PUT | `/api/codebases/{id}/env` | Upsert env var `{key, value}` | api.ts:789 / 3213 |
| DELETE | `/api/codebases/{id}/env/{key}` | Delete env var | api.ts:807 / 3228 |
| GET | `/api/codebases/{id}/environments` | List isolation environments (worktrees) for a codebase | api.ts:1511 / 4991 |

### 2.3 Conversations & messages

| Method | Path | Purpose | Config / Handler |
|---|---|---|---|
| GET | `/api/conversations?platform&codebaseId&mine` | List conversations (limit 50). `mine=true` narrows only when identity resolves (non-enforcing) | api.ts:560 / 2666 |
| GET | `/api/conversations/{id}` | One conversation **by platform conversation id** (e.g. `web-…`) | api.ts:575 / 2697 |
| POST | `/api/conversations` | Create web conversation; body `{codebaseId?, message?}` — with `message` it atomically persists + dispatches | api.ts:591 / 2713 |
| PATCH | `/api/conversations/{id}` | Update title `{title}` | api.ts:612 / 2791 |
| DELETE | `/api/conversations/{id}` | Soft-delete (sets `deleted_at`) | api.ts:635 / 2813 |
| GET | `/api/conversations/{id}/messages?limit=` | Message history (default 200, max 500; tool outputs truncated to 16 KiB) | api.ts:651 / 2832 |
| POST | `/api/conversations/{id}/message` | Send chat message. JSON `{message}` or multipart `message`+`files` (≤5, ≤10 MB each). Returns `{accepted, status}` and processes async under the conversation lock | api.ts:674 / 2850 |

### 2.4 Workflow definitions & commands

| Method | Path | Purpose | Config / Handler |
|---|---|---|---|
| GET | `/api/workflows?cwd=` | Discover workflows (project/home/bundled) + `recommended` + parse warnings | api.ts:443 / 3271 |
| POST | `/api/workflows/validate` | Validate a workflow object (serializes to YAML, parses) | api.ts:459 / 4266 |
| GET | `/api/workflows/{name}?cwd=&source=` | Fetch one definition (`source: project|global|bundled`) | api.ts:480 / 4293 |
| PUT | `/api/workflows/{name}?source=&cwd=` | Save workflow YAML (project or global scope). Body `{definition}` (JSON object) | api.ts:500 / 4401 |
| DELETE | `/api/workflows/{name}?source=&cwd=` | Delete user-defined workflow (not bundled) | api.ts:520 / 4472 |
| DELETE | `/api/workflows/{name}/node-sessions?scope=&node=&confirm=all-scopes` | Reset persisted per-node provider sessions | api.ts:1092 / 4125 |
| GET | `/api/commands?cwd=` | List runnable command names for node palette (bundled<global<project) | api.ts:540 / 4549 |

### 2.5 Workflow runs (driving + observation)

| Method | Path | Purpose | Config / Handler |
|---|---|---|---|
| POST | `/api/workflows/{name}/run` | **Start a run.** JSON `{conversationId, message, inputs?, tiers?, aliases?, config?, adopt_run_id?, supersedes_run_id?}` or multipart (+`files`). Dispatches `/workflow run <name> <message>` into the conversation under the lock | api.ts:830 / 3350 |
| GET | `/api/workflows/runs?conversationId&status&codebaseId&mine&open&limit` | List runs (limit default 50 max 200). `open=true` → open-work inbox (failed, unadopted) | api.ts:916 / 4160 |
| GET | `/api/workflows/runs/{runId}` | Run detail **+ events array** + `worker_platform_id`/`parent_platform_id`/`conversation_platform_id` | api.ts:1112 / 4217 |
| GET | `/api/workflows/runs/by-worker/{platformId}` | Look up run by worker conversation platform id | api.ts:900 / 4202 |
| POST | `/api/workflows/runs/{runId}/cancel` | Cancel (only `running`/`pending`/`paused`) | api.ts:931 / 3657 |
| POST | `/api/workflows/runs/{runId}/resume` | Resume failed/paused run (web parent → chat dispatch; else headless server execution; container runs refuse) | api.ts:948 / 3681 |
| POST | `/api/workflows/runs/{runId}/signal` | Signal an awaited external event: `{event, resumeAt, payload?}` | api.ts:971 / 3749 |
| POST | `/api/workflows/runs/{runId}/abandon` | Abandon (running/paused/failed; cascades sub-runs, reclaims containers) | api.ts:998 / 3774 |
| POST | `/api/workflows/runs/{runId}/approve` | Approve paused gate; body `{comment?}` (empty body allowed); auto-resumes | api.ts:1015 / 3872 |
| POST | `/api/workflows/runs/{runId}/reject` | Reject paused gate; `{reason?}`; runs `on_reject` or cancels | api.ts:1035 / 3939 |
| POST | `/api/workflows/runs/{runId}/respond` | Resolve gate with any declared decision `{decision, text?}` | api.ts:1055 / 4016 |
| DELETE | `/api/workflows/runs/{runId}` | Delete terminal run + events | api.ts:1075 / 4102 |
| GET | `/api/dashboard/runs?status&codebaseId&search&after&before&limit&offset` | Dashboard feed: enriched runs + `counts` | api.ts:885 / 3619 |
| GET | `/api/runs/{runId}/artifacts` | List artifact files (path/size/mtime) under the run's output root | api.ts:858 / 4640 |
| GET | `/api/artifacts/{runId}/*` | Serve one artifact file (raw text, path-traversal guarded). Not in OpenAPI (wildcard) | api.ts:4745 |

### 2.6 Auth & per-user identity (`/api/auth/*`; public when web auth off)

| Method | Path | Purpose | Config / Handler |
|---|---|---|---|
| GET | `/api/auth/status` | `{enabled, signup}` — no auth required, UI gate decision | api.ts:1267 / 1840 |
| POST | `/api/auth/github/device/start` | Start GitHub device flow (App mode only) | api.ts:1280 / 1845 |
| POST | `/api/auth/github/device/poll` | Poll device flow; on success persists token (`status: connected`, `githubLogin`) | api.ts:1295 / 1867 |
| GET | `/api/auth/github` | GitHub connection status for current user | api.ts:1313 / 1899 |
| DELETE | `/api/auth/github` | Disconnect current user's GitHub | api.ts:1327 / 1911 |
| GET | `/api/auth/providers` | List user's connected AI-provider keys + connectable catalog + agent credential matrix | api.ts:1342 / 1927 |
| PUT | `/api/auth/providers/{provider}` | Store API key `{apiKey, label?}` (encrypted; never echoed) | api.ts:1356 / 1958 |
| DELETE | `/api/auth/providers/{provider}` | Disconnect a key (idempotent) | api.ts:1376 / 1984 |
| POST | `/api/auth/providers/{provider}/oauth/start` | Start subscription (OAuth) login for provider | api.ts:1392 / 2012 |
| POST | `/api/auth/providers/{provider}/oauth/poll` | Poll OAuth session `{sessionId, code?}` | api.ts:1410 / 2050 |
| GET | `/api/auth/me/ai-prefs` | User tiers/aliases/default (raw per-user layer) | api.ts:1429 / 2112 |
| PATCH | `/api/auth/me/ai-prefs/tiers` | Per-user tier presets (null unsets) | api.ts:1444 / 2123 |
| PATCH | `/api/auth/me/ai-prefs/aliases` | Per-user `@alias` presets (null unsets) | api.ts:1466 / 2148 |
| PATCH | `/api/auth/me/ai-prefs/default` | Default assistant + chat model pin | api.ts:1488 / 2176 |

The remaining `/api/auth/*` surface belongs to **Better Auth** (email+password sign-in/sign-up/
session/sign-out), mounted as a raw catch-all handler at `index.ts:709-731`; Archon-owned paths above
fall through via `isArchonOwnedAuthPath()` (`packages/server/src/auth/config.ts:115-125`).

### 2.7 Webhooks / internal (outside `/api`, signed)

- `POST /webhooks/github` — `x-github-event`, `x-hub-signature-256` (HMAC) → `handleWebhook` fire-and-forget, `200 OK` (`routes/webhooks.ts:24-49`).
- `POST /webhooks/gitea` — `x-gitea-event`, `x-gitea-signature` (`index.ts:785-809`).
- `POST /webhooks/gitlab` — `x-gitlab-event`, `x-gitlab-token` (`index.ts:813-835`).
- `POST /internal/git-credential` — vend live GitHub installation tokens; loopback-only guard
  (`index.ts:759-781`, fatal on public bind unless `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1`,
  `index.ts:888-902`).

---

## 3. SSE / realtime protocol

### 3.1 Endpoints

| Endpoint | Meaning |
|---|---|
| `GET /api/stream/{conversationId}` | Per-conversation stream. `conversationId` is the **platform conversation id** (`web-…`). All adapter output + workflow events for runs executing in the server process (registered via `WebAdapter`) (`api.ts:3008-3047`) |
| `GET /api/stream/__dashboard__` | Multiplexed dashboard stream: `workflow_status` + `dag_node` events for **every** run writing to the DB, including out-of-process CLI runs (poller replay). Must be registered before the `:conversationId` route (`api.ts:2972-3005`) |

Both: heartbeat written immediately on connect (flushes headers) then every **30 s**
(`stream.sleep(30000)`), `onAbort` unregisters. Each SSE frame is a single JSON document in the
`data:` field (no named SSE `event:` type): `stream.writeSSE({ data: JSON.stringify(event) })`
(`api.ts:2974-2992`; `transport.ts:180`).

### 3.2 Wire event catalog (client typings: `packages/web/src/lib/types.ts`; producers: `adapters/web.ts`, `adapters/web/workflow-bridge.ts`)

Discriminated on `type`. `timestamp` is epoch ms on every event.

| `type` | Fields | Producer / source |
|---|---|---|
| `text` | `content`, `isComplete`, optional `category` (`tool_call_formatted`, `workflow_status`, `workflow_dispatch_status`, `isolation_context`, `workflow_result`), optional `workflowResult {workflowName,runId}` | `web.ts:80-87` — adapter prose; `isolation_context`/`tool_call_formatted` still persist but are skipped on SSE (`web.ts:69-75`) |
| `tool_call` | `toolCallId?`, `name`, `input`, `timestamp` | `web.ts:135-141` (stable SDK id when present, else `${conversationId}-tool-N`) |
| `tool_result` | `toolCallId?`, `name`, `output` (**truncated to 16 KiB**, full kept in DB), `duration` | `web.ts:197-204`; `adapters/web/truncate.ts:10` |
| `session_info` | `sessionId`, optional `cost`/`tokensIn`/`tokensOut` | `web.ts:205-210` |
| `conversation_lock` | `conversationId`, `locked`, `queuePosition?` | `web.ts:308-315` (sent by API dispatch around `handleMessage`, `api.ts:2384-2406`) |
| `retract` | — | `web.ts:341-345` (clears UI + persistence segment) |
| `error` | `message`, `classification` (`transient`/`fatal`), `suggestedActions?` | `api.ts:2393-2401`; `web.ts` |
| `warning` | `message` | `api.ts:2940-2944`; `persistence.ts:269-276` |
| `system_status` | `content` | `web.ts:218-223` |
| `heartbeat` | — | stream loop |
| `workflow_dispatch` | `workerConversationId`, `workflowName` | `web.ts:211-217` |
| `workflow_status` | `runId`, `workflowName`, `status` (`running|completed|failed|cancelled|paused`), `error?`, `approval? {nodeId,message}` | `workflow-bridge.ts:16-33` (in-process emitter) and `:219-329` (DB rows via poller: `approval_requested`→paused, `approval_received`→running) |
| `workflow_step` | `runId`, `nodeId?`, `step`, `total`, `name` (`iteration-N`), `status`, `iteration`, `duration?` | loop iterations, `workflow-bridge.ts:35-77` |
| `dag_node` | `runId`, `nodeId`, `name`, `status` (`running|completed|failed|skipped`), `duration?`, `error?`, `reason?` (`when_condition`/`trigger_rule`) | `workflow-bridge.ts:90-111` (emitter), `:227-236,331-346` (DB rows) |
| `workflow_artifact` | `runId`, `artifactType`, `label`, `url?`, `path?` | `workflow-bridge.ts:79-88` (in-process only) |
| `workflow_tool_activity` | `runId`, `toolName`, `stepName`, `status` (`started`/`completed`), `durationMs?` | `workflow-bridge.ts:113-136` |
| `workflow_task_activity` | `runId`, `nodeId`, `taskId`, `activity`, `description?/summary?/usage?/lastToolName?/taskType?` | `workflow-bridge.ts:160-173` |
| `workflow_hook_activity` | `runId`, `nodeId`, `hookId`, `hookName`, `hookEvent`, `activity`, `outcome?`, `exitCode?` | `workflow-bridge.ts:175-187` |
| `workflow_output_preview` | `runId`, `lines[]` | used by the console's output preview (not emitted by current bridge sources) |
| `container_lifecycle` | `runId`, `phase`, `containerId?` | `workflow-bridge.ts:189-196` |

### 3.3 Reconnect / buffering behavior (`adapters/web/transport.ts`)

- One active stream per conversation: a new `registerStream` **closes the old** (browser refresh/new tab)
  (`transport.ts:70-77`); removal uses the expected-stream guard against stale aborts
  (`transport.ts:114-127`).
- **Replay buffer**: if no stream is connected when an event is emitted, the event is buffered
  (cap 500 events; TTL 60 s) and **replayed on next connect** (`transport.ts:176-263`). Events emitted
  into a closed stream are buffered too (`transport.ts:190-195`).
- **Reconnect grace**: `removeStream` schedules cleanup after `RECONNECT_GRACE_MS = 5000`
  (`transport.ts:17`, `279-301`); a reconnect within 5 s cancels the cleanup (persistence state —
  conversation-id → DB-id map, buffered assistant segments — survives). TTL invariant enforced at
  module load (`transport.ts:41-45`).
- Zombie reaper closes `closed` streams every 5 min (`transport.ts:134-145`); failed `writeSSE`
  removes + closes the stream so the browser EventSource auto-reconnects (`transport.ts:180-195`).
- The client relies on native `EventSource` auto-reconnect (no manual backoff) and distinguishes
  transient CONNECTING from CLOSED (`useSSE.ts:100-113`).

### 3.4 Cross-process + dashboard fan-out

- In-process workflow events → per-run conversation stream **and** `__dashboard__`
  (`workflow-bridge.ts:370-384`).
- Worker→parent bridging for background web runs: `bridgeWorkerEvents(workerConvId, parentConvId)`
  forwards the worker's events to the parent conversation stream and flushes the worker's message
  buffer on step transitions (`workflow-bridge.ts:398-424`; wired via `WebAdapter.setupEventBridge`).
- Out-of-process runs (CLI `--detach`): `DashboardEventPoller` tails
  `remote_agent_workflow_events` (`created_at >= cursor`, 500-row drain, dedup at boundary second)
  and replays only dashboard-relevant event types → `__dashboard__`
  (`dashboard-event-poller.ts:120-148`; `workflow-bridge.ts:265-270`). On Postgres a trigger runs
  `pg_notify('archon_dashboard_event', …)` on event insert (`packages/core/src/db/adapters/postgres.ts:22`)
  which `PgNotifyListener` uses to wake the poller (`pg-notify-listener.ts:40-65`).

**Observation consequence for an external UI**: the *dashboard* stream + REST are the reliable
observability surface for runs from any process; the *per-conversation* stream only carries live
events for runs the server process itself executed (chat turns, web-dispatched background runs).

---

## 4. Auth model

Archon's HTTP auth is layered and posture-dependent:

1. **Solo/local (default)**: **no auth**. Web adapter is "no auth (single-developer tool)"
   (`adapter-implementation-guide.md:207`); nothing gates `/api/*`.
2. **`auth-service/`** (repo top-level, deployment concern — *not* in the request path by default):
   a tiny Node `http` server used by **Caddy `forward_auth`** behind the optional cloud profile.
   Cookie (`archon_auth`, HMAC-signed, bcrypt-checked at login) + `/verify` endpoint emitting the
   `X-Auth-User` header; `/login`, `/logout` HTML. Env: `AUTH_USERNAME`, `AUTH_PASSWORD_HASH`,
   `COOKIE_SECRET`, `COOKIE_MAX_AGE`, `AUTH_SERVICE_PORT=9000`
   (`auth-service/server.js:8-14,142-210`; compose `auth-service` service under `--profile auth`,
   `docker-compose.yml:119-129`; `Caddyfile.example:25-41`). It is the **pre-Better-Auth** proxy-auth
   layer, still supported for proxy deploys.
3. **Better Auth (opt-in, Postgres-only)** — real per-user email/password login, mounted at
   `/api/auth/*`:
   - Enabled only when **`DATABASE_URL` (Postgres) AND `BETTER_AUTH_SECRET` (≥32 chars)** are set
     (`packages/server/src/auth/config.ts:25-27`, `assertWebAuthAtBoot` `config.ts:35-44`).
     SQLite installs can never enable it (`config.ts:21-24`).
   - Instance: lazy singleton owning a dedicated pg pool; tables renamed to
     `remote_agent_auth_user/session/account/verification` (`auth/instance.ts:86-135`);
     email+password only, signup posture `allowlist | open | disabled` (default **disabled**)
     enforced via `disableSignUp` + `databaseHooks.user.create.before`
     (`auth/instance.ts:99,104-134`; `auth/config.ts:80-96`).
   - **API gate**: when enabled and `ARCHON_WEB_AUTH_REQUIRED !== 'false'`, every `/api/*` request
     must resolve to an identity → 401, except `/api/auth/*` and `/api/health*`
     (`api.ts:1708-1716`; `auth/config.ts:94-96`). This makes Better Auth the real access boundary.
   - Identity resolution (`api.ts:1734-1778`): (1) Better Auth session cookie →
     `userDb.findOrCreateUserByPlatformIdentity('web', session.user.id, …)` (maps to canonical
     `remote_agent_users` via `remote_agent_user_identities`); (2) fallback: trusted reverse-proxy
     header `X-Archon-User` (configurable `ARCHON_WEB_AUTH_HEADER`). Soft seam returns `undefined`
     (NULL attribution) rather than throwing. `requireWebUser()` is the strict variant
     (401 vs 503) used by `/api/auth/*` identity endpoints (`api.ts:1792-1832`).
   - **Header trust warning**: on non-loopback binds, forging `X-Archon-User` is possible; server
     warns (or refuses, for the token-vending internal route) (`index.ts:888-925`).
   - Roles: `remote_agent_users.role` defaults `admin` (`000_combined.sql:480-481`); reserved for
     future scoping. Visibility stays open (multi-user = several users, not multi-tenancy;
     `AGENTS.md:20`).
4. **Adapter-level auth** (chat/forge ingress, not HTTP): allowlists parsed from env
   (`SLACK_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_USER_IDS`,
   `GITHUB_ALLOWED_USERS`, `GITEA_ALLOWED_USERS`, `GITLAB_ALLOWED_USERS`) with silent rejection;
   GitHub webhooks HMAC-SHA256, Gitea HMAC signature, GitLab `x-gitlab-token`; GitHub App mode
   authenticates as installation, PAT mode as token owner
   (`adapter-implementation-guide.md:44-55`; env refs in `.env.example:162-244`).

**Endpoints needing identity** (web auth enabled): everything except `/api/auth/*` + `/api/health*`.
**Endpoints *requiring* identity semantics** (401 on missing, even when gate off? No — `requireWebUser`
runs regardless of the gate; on solo installs with no header/no Better Auth it returns 401) — i.e.
the per-user connect/prefs endpoints always demand a resolved user: GitHub device flow, provider
keys/OAuth, `me/ai-prefs` (see §2.6 handlers calling `requireWebUser`).

---

## 5. Web UI

### 5.1 Application shell & routes (`packages/web/src/App.tsx`)

React + Vite + `@tanstack/react-query` + Zustand + Tailwind/shadcn. Three zones:

- `/login` — Better Auth login/signup (rendered only when auth enabled) (`LoginPage.tsx`).
- `/console/*` — **new default UI** (root `/` redirects to `/console`), the "Console" experiment
  (`App.tsx:76-91`; `experiments/console/ConsoleApp.tsx`). Sessions wrapped in `<SessionGate>`
  (checks `/api/auth/status` + session; passes through when auth disabled).
- `/legacy/*` — classic UI under `<Layout>` (`App.tsx:97-118`): `chat`, `dashboard`, `workflows`,
  `workflows/builder`, `workflows/runs/:runId`, `settings`.

### 5.2 Page inventory (legacy `packages/web/src/routes/`, components under `components/`)

| Route | Page | Renders / data |
|---|---|---|
| `/legacy/chat` | `ChatPage.tsx` | Conversation sidebar + `ChatInterface`: TanStack Query lists (`listConversations`, `getMessages`, `listWorkflowRuns`), `useSSE(conversationId)` live stream; composer → `sendMessage`/multipart upload; run-from-chat via `/workflow` command text |
| `/legacy/dashboard` | `DashboardPage.tsx` | Command Center: `useDashboardSSE` + `listDashboardRuns`, run cards grouped by status with cancel/resume/abandon/delete/approve/reject; health panel |
| `/legacy/workflows` | `WorkflowsPage.tsx` | `WorkflowList` (discover via `/api/workflows`), link to builder |
| `/legacy/workflows/builder` | `WorkflowBuilderPage.tsx` | `WorkflowBuilder` — canvas + node palette + inspector + YAML view/validation (see §5.4) |
| `/legacy/workflows/runs/:runId` | `WorkflowExecutionPage.tsx` | `WorkflowExecution` run detail: DAG graph viewer, step logs, artifacts, events; SSE per conversation |
| `/legacy/settings` | `SettingsPage.tsx` | Config (`/api/config`), providers, codebases CRUD + env vars, GitHub connection/device flow, per-user provider keys, assistant/tiers/aliases |

### 5.3 Console (current default, `experiments/console/`)

Project-scoped shell: left `ProjectRail`, command palette (`p`), keyboard map; internal routes:
`RunsPage` (index or `p/:projectId`), `ChatPage` (`p/:projectId/chat`), `RunDetailPage`
(`p/:projectId/r/:runId`), `BuilderConnected` (`/builder`, `/builder/:name`), `PreviewPage`,
`SettingsPage` (`ConsoleApp.tsx:74-83`). Components mirror the API surfaces: `RunCard/ActiveRunCard`,
`WorkflowDock`, `RunStream`, `ArtifactPanel` (`/api/runs/:runId/artifacts`), `ApprovalPanel`
(approve/reject/respond), `AgentCredentialCard`/`ModelTiersPanel`/`AliasesPanel`/`GithubIdentityPanel`
(`/api/auth/*`), `EnvVarsDialog`.

**Console data flow is cache-invalidation over SSE** (`experiments/console/lib/sse.ts:1-13`): the
console treats SSE events purely as invalidation triggers for its local entity cache (`store/cache.ts`,
`store/keys.ts`); the authoritative state is always refetched from REST (`useEntity`). The chat view
uses `useRunStreamSSE`/`useConversationSSE` to invalidate message/run caches on `text`/`tool_*`/
`workflow_*` and to disable the composer on `conversation_lock` (`sse.ts:91-228`). REST calls go
through `lib/http.ts` (`requestJson`, `credentials: 'same-origin'`) (`http.ts:54-72`).

### 5.4 Real-time plumbing

- `hooks/useSSE.ts` — `new EventSource(SSE_BASE_URL/api/stream/<conversationId>)`; parses each
  message, batches `text` fragments over 50 ms, maps events to handlers (`onText/onToolCall/
  onToolResult/onLockChange/onWorkflowStatus/onDagNode/…`), handles `retract` by dropping buffered
  text (`useSSE.ts:129-253`).
- `hooks/useDashboardSSE.ts` — subscribes to `/api/stream/__dashboard__` and forwards
  `workflow_status`, `dag_node`, `workflow_tool_activity`, `workflow_step`,
  `workflow_task_activity`, `workflow_hook_activity` to the Zustand `workflow-store` which maintains
  active-run maps and hydrates details from REST (`stores/workflow-store.ts`).
- TanStack Query client: staleTime 10 s, refetch on window focus (`lib/query-client.ts:3-10`).
- **Auth**: `lib/auth-client.ts` = `createAuthClient()` (Better Auth React), same-origin
  (cookie-first-party).

### 5.5 Generated API types

- Source of truth: Zod schemas in `packages/server/src/routes/schemas/*.ts` (+ shared engine schemas
  from `@archon/*`/`core/schemas`), registered on routes.
- `GET /api/openapi.json` is fed to `openapi-typescript` by
  `packages/server/src/scripts/generate-api-types.ts`, writing
  `packages/web/src/lib/api.generated.d.ts` (`generate-api-types.ts:7-31`).
- `packages/web/src/lib/api.ts` wraps every endpoint in typed functions over `components['schemas'][…]`
  (`api.ts:9-24`) and is the **only** layer the UI imports — the web client never imports server or
  workflow runtime packages (`AGENTS.md:114`). A third-party frontend can consume
  `api.generated.d.ts` + `api.ts` patterns directly, or just the OpenAPI doc.

### 5.6 Workflow Builder capability

Two builders exist; both are full round-trip YAML editors driven by REST:

- **Console builder** (`experiments/console/builder/`) — a real **node-graph canvas**:
  `BuilderCanvas`, `NodePalette`, `BuilderNodeView`, `Inspector` with per-variant field editors
  (`PromptFields`, `BashFields`, `CommandFields`, `ScriptFields`, `LoopFields`, `WaitFields`,
  `ApprovalFields`, `CancelFields`), `WhenBuilder`, `SmartGuides`, `Toolbar`, `YamlPreview`,
  `BuilderContextMenu`. It converts flow ↔ model ↔ YAML (`flow/`, `model/`, `yaml/serialize.ts`),
  validates structurally + per-node content + graph + `when` grammar (`validation/`), persists via
  the same save path (`builder/connect/save-logic.ts`, `use-builder-project.ts`) and supports
  undo/history, clipboard, alignment, keymap (`editor/`).
- **Legacy builder** (`components/workflows/WorkflowBuilder.tsx` + `WorkflowCanvas`,
  `DagNodeComponent`, `NodePalette`, `NodeInspector`, `YamlCodeView`, `ValidationPanel`), with
  `lib/dag-layout.ts` laying out the graph.

Both write through `GET/PUT/DELETE /api/workflows/{name}` (server serializes the JSON `definition`
with `Bun.YAML.stringify` and parses back for validation — `api.ts:4431-4461`), validate via
`POST /api/workflows/validate`, list commands for the palette via `GET /api/commands`, and run via
`POST /api/workflows/{name}/run`.

### 5.7 How a third-party UI reuses the API

Everything the SPA does is plain HTTPS REST + `EventSource` SSE against the same origin (or a
CORS-enabled origin; default `Access-Control-Allow-Origin: *`, tighten with `WEB_UI_ORIGIN`,
`api.ts:1690`). Requirements: register a project (`POST /api/codebases`), create a web conversation
(`POST /api/conversations`, id pattern `web-<ts>-<rand>`), then either chat
(`POST /api/conversations/:id/message`) or launch workflows (`POST /api/workflows/:name/run`); open
`/api/stream/:platformConversationId` for live chat/run events and `/api/stream/__dashboard__` for
cross-process run activity; poll REST for authoritative state. If web auth is enabled, the client
must send the Better Auth session cookie (same-origin) or be behind a proxy that sets
`X-Archon-User`; no bearer-token API exists.

---

## 6. Database logical schema (from `migrations/`)

Two dialects are kept aligned: **PostgreSQL** (`DATABASE_URL` set) and **SQLite** (`bun:sqlite`,
default). Auto-detect at connection (`core/src/db/connection.ts`; deep-dive §5). Dialect adaptation
(placeholder rewrite, `::jsonb` strip, `json_patch` vs `jsonb ||`, `now()` vs `datetime('now')`,
`gen_random_uuid()` vs `crypto.randomUUID()`).

**Significance of `migrations/000_combined.sql`**: the canonical, idempotent **Postgres** schema
(fresh-install `CREATE TABLE IF NOT EXISTS` + additive `ALTER … ADD COLUMN IF NOT EXISTS` for
upgrades). It is embedded into the binary/source as `BUNDLED_SCHEMA_SQL`
(`packages/core/src/db/bundled-schema.generated.ts:13`, generated from the file by
`scripts/generate-bundled-schema.ts`) and **auto-applied on every startup** by the Postgres adapter
(`core/src/db/adapters/postgres.ts:66-69`) and — inline SQL, hand-maintained to parity — by the
SQLite adapter (`core/src/db/adapters/sqlite.ts:207`; parity enforced by test
`core/src/db/adapters/sqlite.test.ts:541-709`). Docker also mounts it into Postgres's initdb
(`docker-compose.yml:78-79`). Files `001…023` are the historical per-change migration trail; the
code applies only the combined file, so `000_combined.sql` is authoritative. SQLite is a separate
inline schema with an enforced **test**: upgrade paths are validated from shipped vintages
(`core/src/db/fixtures/sqlite-vintages/v0.10.0.sql`).

### 6.1 Tables (logical, final state — columns from `000_combined.sql`)

| Table | Purpose | Key columns / relations |
|---|---|---|
| `remote_agent_codebases` | Registered project (git repo or folder) | `id uuid PK`, `name`, `repository_url`, `default_cwd`, `default_branch`, `ai_assistant_type`, `kind ('repo'\|'folder')`, `allow_env_keys`, `commands jsonb`, timestamps (000:39-51) |
| `remote_agent_codebase_env_vars` | Per-project env vars injected into AI subprocesses | `codebase_id FK→codebases CASCADE`, `key`, `value`, `UNIQUE(codebase_id,key)` (000:60-68) |
| `remote_agent_users` | Canonical platform-agnostic Archon user | `display_name`, `email`, `role default 'admin'` (000:77-83, 480-481) |
| `remote_agent_user_identities` | Platform-native id → user | `user_id FK→users CASCADE`, `platform` (`web`, `slack`, `telegram`, `discord`, `github`, `cli`, `api`, …), `platform_user_id`, `platform_display_name`, `UNIQUE(platform, platform_user_id)` (000:92-100) |
| `remote_agent_conversations` | One row per platform conversation | `platform_type`, `platform_conversation_id`, `UNIQUE(platform_type, platform_conversation_id)`, `codebase_id FK SET NULL`, `cwd`, `ai_assistant_type`, `isolation_env_id FK SET NULL`, `user_id FK SET NULL`, `title`, `deleted_at` (soft delete), `hidden`, `last_activity_at` (000:109-124 + 171-174, 313-357) |
| `remote_agent_sessions` | Immutable AI-session audit chain per conversation | `conversation_id FK CASCADE`, `codebase_id`, `ai_assistant_type`, `assistant_session_id` (SDK resume), `active`, `metadata jsonb`, `parent_session_id FK self`, `transition_reason`, `ended_reason`, started/ended (000:130-143) |
| `remote_agent_isolation_environments` | Work-centric worktree/container envs | `codebase_id FK CASCADE`, `workflow_type` (`issue/pr/review/thread/task`), `workflow_id`, `provider`, `working_path`, `branch_name`, `status ('active'\|'destroyed')`, `created_by_platform`, `created_by_user_id`, `metadata`; partial unique `(codebase_id,workflow_type,workflow_id) WHERE status='active'` (000:149-169, 656-660) |
| `remote_agent_workflow_runs` | Executing/paused/terminal run | `workflow_name`, `conversation_id FK CASCADE`, `codebase_id FK`, `status default 'pending'` (`pending/running/completed/failed/cancelled/paused`), `outcome ('succeeded'\|'failed')` CHECK, `user_message`, `metadata jsonb` (incl. `wait`, `approval`, `scheduled_resume`, `isolation`), `parent_conversation_id FK`, `parent_run_id FK self`, `adopted_from_run_id FK self`, `user_id FK`, `started_at`, `completed_at`, `last_activity_at`, `working_path`, `output_root` (000:183-201 + 359-389) |
| `remote_agent_workflow_events` | UI-relevant event log for runs | `workflow_run_id FK CASCADE`, `event_order bigint` (sequence default), `event_type` (e.g. `workflow_started/completed/failed/cancelled`, `node_started/completed/failed/skipped`, `loop_iteration_*`, `approval_requested/received`, …), `step_index`, `step_name`, `data jsonb`, `created_at`; `UNIQUE(run_id, event_order) WHERE event_order IS NOT NULL`; global `created_at` index serves the dashboard poller (000:210-219, 499-504, 694-707) |
| `remote_agent_workflow_run_node_sessions` | Private per-run node session handles (cascades with run, never exposed by API) | `PK(workflow_run_id, node_id)`, `provider`, `provider_session_id` (000:228-236) |
| `remote_agent_workflow_node_sessions` | `persist_session: true` opt-in, cross-run resume | `PK(workflow_name, node_id, scope_key, provider)`, `provider_session_id`, `last_run_id FK` (000:245-255; migration 022) |
| `remote_agent_messages` | Persisted chat history (web adapter + headless) | `conversation_id FK CASCADE`, `role ('user'\|'assistant')`, `content`, `metadata jsonb` (`toolCalls[]`, `category`, `workflowDispatch`, `workflowResult`, `files`), `user_id FK SET NULL`, `created_at` (000:264-271, 349-351) |
| `remote_agent_user_github_tokens` | Per-user GitHub device-flow tokens, encrypted at rest | `user_id FK CASCADE UNIQUE`, `github_user_id`, `github_login`, `access_token_encrypted`, `refresh_token_encrypted`, expiries (000:394-406) |
| `remote_agent_user_provider_keys` | Per-user AI-provider credentials (API key or OAuth), encrypted; `kind` discriminates; vendor-keyed ids (`anthropic`, `openai`, `github-copilot`, …) | `UNIQUE(user_id, provider)`, `api_key_encrypted`/`oauth_creds_encrypted`, `label` (000:413-424 + vendor migration 435-448) |
| `remote_agent_user_ai_prefs` | Per-user tiers/aliases/default (non-secret, JSON-as-text) | `UNIQUE(user_id)`, `tiers text`, `aliases text`, `default_provider`, `default_model` (000:455-465, 471-472) |
| `remote_agent_schema_version` | Schema vintage diagnostic (single row id=1) | `created_app_version`, `app_version`, `created_at`, `applied_at` (000:516-522) |
| `remote_agent_auth_user` / `_session` / `_account` / `_verification` | **Better Auth tables (Postgres only)** | Better Auth-owned camelCase columns/text ids; session/account FK→auth_user CASCADE; Archon maps auth sessions → `remote_agent_users` via `user_identities('web', …)` (000:536-580; `auth/instance.ts:100-103`) |

**Dropped legacy objects**: `remote_agent_command_templates` (table 002, dropped in 017 —
commands are file-based under `.archon/commands` now) and conversations columns `worktree_path`,
`isolation_env_id_legacy`, `isolation_provider` (003→007) (000:277-289).

### 6.2 Migration-by-migration trail

| File | Adds |
|---|---|
| `001_initial_schema.sql` | `codebases`, `conversations`, `sessions` + indexes |
| `002_command_templates.sql` | `remote_agent_command_templates` (later dropped) |
| `003_add_worktree.sql` | `conversations.worktree_path` |
| `004_worktree_sharing.sql` | partial index on `worktree_path` |
| `005_isolation_abstraction.sql` | `conversations.isolation_env_id` (varchar), `isolation_provider`; data migration |
| `006_isolation_environments.sql` | `remote_agent_isolation_environments` table; conversation FK; `last_activity_at` |
| `007_drop_legacy_columns.sql` | drop `worktree_path`, legacy isolation columns |
| `008_workflow_runs.sql` | `remote_agent_workflow_runs` (status default `running` initially) |
| `009_workflow_last_activity.sql` | `workflow_runs.last_activity_at` |
| `010_immutable_sessions.sql` | `sessions.parent_session_id`, `transition_reason` (session chains) |
| `011_partial_unique_constraint.sql` | unique active workflow per codebase/type/id |
| `012_workflow_events.sql` | `remote_agent_workflow_events` |
| `013_conversation_titles.sql` | `conversations.title`, `deleted_at` |
| `014_message_history.sql` | `remote_agent_messages` |
| `015_background_dispatch.sql` | `workflow_runs.parent_conversation_id`; `conversations.hidden` |
| `016_session_ended_reason.sql` | `sessions.ended_reason` |
| `017_drop_command_templates.sql` | drop table + index |
| `018_fix_workflow_status_default.sql` | status default → `pending` (matches SQLite) |
| `019_workflow_resume_path.sql` | `workflow_runs.working_path` |
| `020_codebase_env_vars.sql` | `remote_agent_codebase_env_vars` |
| `021_add_allow_env_keys_to_codebases.sql` | `codebases.allow_env_keys` |
| `022_workflow_node_sessions.sql` | `remote_agent_workflow_node_sessions` (+ run-scoped variant in combined) |
| `023_add_default_branch_to_codebases.sql` | `codebases.default_branch` |

**Postgres-only bits** (from combined + code): `gen_random_uuid()`, `JSONB`, `TIMESTAMP WITH TIME
ZONE` (SQLite uses plain `datetime` semantics), partial indexes, the `event_order` sequence, the
`pg_notify('archon_dashboard_event')` trigger on workflow events (`core/src/db/adapters/postgres.ts:22`),
and the four Better Auth tables (`000_combined.sql:527-580`). SQLite parity is enforced by the
schema-parity test; SQLite gets `json_patch`-based merges and `?` placeholders at runtime
(deep-dive §5; `architecture-deep-dive.md:181-207`).

---

## 7. Env / config reference (`.env.example` + code)

Server default port **3090** in dev (`vite.config.ts:11`, `.env.example:247`); **Docker default
3000** (`docker-compose.yml:46`, `Dockerfile:199`). Bind `HOST` (default `0.0.0.0`). Full catalog:

| Group | Variables |
|---|---|
| Database | `DATABASE_URL` (unset ⇒ SQLite at `~/.archon/archon.db`); compose-only `POSTGRES_PASSWORD`, `POSTGRES_PORT` |
| Claude | `CLAUDE_USE_GLOBAL_AUTH`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_API_KEY`, `CLAUDE_BIN_PATH` |
| Codex | `CODEX_ID_TOKEN`, `CODEX_ACCESS_TOKEN`, `CODEX_REFRESH_TOKEN`, `CODEX_ACCOUNT_ID`, `CODEX_BIN_PATH` |
| Copilot | `COPILOT_GITHUB_TOKEN`, `COPILOT_BIN_PATH` |
| Pi | `PI_CODING_AGENT_DIR` + backend keys `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN` |
| Assistant defaults | `DEFAULT_AI_ASSISTANT`, `TITLE_GENERATION_MODEL` |
| GitHub bot | `GH_TOKEN`/`GITHUB_TOKEN` (PAT) or App: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY(_PATH)`, `GITHUB_APP_SLUG`, `GITHUB_APP_INSTALLATION_ID`, `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND`; per-user: `GITHUB_APP_CLIENT_ID`, `TOKEN_ENCRYPTION_KEY`, `ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK`; `WEBHOOK_SECRET`, `GITHUB_ALLOWED_USERS`, `GITHUB_BOT_MENTION` |
| Forges | GitLab: `GITLAB_URL`, `GITLAB_TOKEN`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_ALLOWED_USERS`, `GITLAB_BOT_MENTION`. Gitea: `GITEA_URL`, `GITEA_TOKEN`, `GITEA_WEBHOOK_SECRET`, `GITEA_ALLOWED_USERS`, `GITEA_BOT_MENTION` |
| Chat platforms | `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`+`SLACK_APP_TOKEN`; allowlists `SLACK_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_USER_IDS`; streaming `TELEGRAM_STREAMING_MODE=stream`, `DISCORD_STREAMING_MODE=batch`, `SLACK_STREAMING_MODE=batch`; `DISCORD_REQUIRE_MENTION`; `BOT_DISPLAY_NAME` |
| Server / web UI | `PORT`, `HOST`, `WEB_UI_DEV` (dev only), `WEB_UI_ORIGIN` (CORS), `DOMAIN` + `CADDY_BASIC_AUTH` (cloud profile), auth-service vars `AUTH_USERNAME`, `AUTH_PASSWORD_HASH`, `COOKIE_SECRET`, `AUTH_SERVICE_PORT=9000`, `COOKIE_MAX_AGE` |
| Web auth (Better Auth) | `BETTER_AUTH_SECRET` (≥32), `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `ARCHON_AUTH_ALLOWED_EMAILS`, `ARCHON_AUTH_OPEN_SIGNUP`, `ARCHON_WEB_AUTH_REQUIRED`, plus trusted header `ARCHON_WEB_AUTH_HEADER` (default `X-Archon-User`) |
| Paths (host) | `ARCHON_HOME`, `ARCHON_DATA`, `ARCHON_USER_HOME`, `ARCHON_ALLOW_ROOT_FALLBACK`, `WSL_DISTRO_NAME` |
| Runtime | `LOG_LEVEL`, `MAX_CONCURRENT_CONVERSATIONS=10`, `SESSION_RETENTION_DAYS=30` |
| Telemetry | `ARCHON_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, `POSTHOG_API_KEY` (`off` disables), `POSTHOG_HOST`; CLI `archon telemetry status/reset` |
| Docker | `ARCHON_DOCKER=true` (set by compose), `PI_CODING_AGENT_DIR` |

---

## 8. Seams for external driving / observation

### 8.1 Can an external UI drive Archon over HTTP? Yes — named seams

| Action | Endpoint (payload) |
|---|---|
| Register a project | `POST /api/codebases` `{url}` or `{path}` (api.ts:3094) |
| Create a web conversation | `POST /api/conversations` `{codebaseId?, message?}` → `{conversationId, id, dispatched?}` (api.ts:2713) |
| Send a chat message (freeform or `/command`) | `POST /api/conversations/{platformId}/message` `{message}` or multipart (api.ts:2850) |
| **Start a workflow run** | `POST /api/workflows/{name}/run` `{conversationId, message, inputs?, tiers?, aliases?, config?, adopt_run_id?, supersedes_run_id?}` (api.ts:3350). `message` is the run brief appended to the internal `/workflow run <name> …` command (api.ts:3593); the response is only `{accepted, status}` — the run id arrives later via SSE/`workflow_dispatch`/REST |
| Cancel | `POST /api/workflows/runs/{runId}/cancel` — running/pending/paused only (api.ts:3657) |
| Abandon (+ cascade sub-runs, reclaim containers) | `POST /api/workflows/runs/{runId}/abandon` (api.ts:3774) |
| Resume | `POST /api/workflows/runs/{runId}/resume` (api.ts:3681) — resumable statuses only; headless execution if no web parent (api.ts:3697-3716); container runs refuse (services/workflow-resume-service.ts:108-111) |
| Resolve human gate | `approve` `{comment?}` (api.ts:3872), `reject` `{reason?}` (api.ts:3939), generic `respond` `{decision,text?}` (api.ts:4016); each auto-resumes a web-parent run or headless-executes (api.ts:3924, 3993, 4086; resume service:159) |
| Signal external awaited event | `POST /api/workflows/runs/{runId}/signal` `{event, resumeAt, payload?}` (api.ts:3749) |
| Delete terminal run | `DELETE /api/workflows/runs/{runId}` (api.ts:4102) |
| Save/edit/delete workflow YAML | `PUT|DELETE /api/workflows/{name}` (api.ts:4401, 4472), validate `POST /api/workflows/validate` |
| Approve-oriented prefs/config | `PATCH /api/config/*`, `PATCH /api/auth/me/ai-prefs/*` |

### 8.2 Observation seams

| Observe | Endpoint |
|---|---|
| List runs (+ status filter, `mine`, open-work inbox) | `GET /api/workflows/runs` (api.ts:4160) |
| Dashboard feed with counts/search/pagination | `GET /api/dashboard/runs` (api.ts:3619) |
| **Run detail incl. full event history** | `GET /api/workflows/runs/{runId}` → `{run, events[]}` (api.ts:4217) |
| Find run by worker conversation | `GET /api/workflows/runs/by-worker/{platformId}` (api.ts:4202) |
| Live chat + run events for one conversation | `GET /api/stream/{platformConversationId}` (api.ts:3008) — events in §3.2; replay-buffered across reconnects |
| Live workflow lifecycle for **all** runs (any process) | `GET /api/stream/__dashboard__` (api.ts:2972) |
| Artifacts list + content | `GET /api/runs/{runId}/artifacts` (api.ts:4640); `GET /api/artifacts/{runId}/*` (api.ts:4745) |
| Message history (authoritative after SSE) | `GET /api/conversations/{id}/messages` (api.ts:2832) |
| Isolation envs of a project | `GET /api/codebases/{id}/environments` (api.ts:4991) |

### 8.3 Gaps — things the API does not do (CLI/chat-only or absent)

- **No endpoint starts/controls non-web platform conversations** (Telegram/Slack/Discord/Slack
  threads are inbound-only from those platforms). Web conversations are the only client-creatable
  surface (they also carry the `web-…` id convention, `api.ts:2726`).
- **No REST to manage isolation environments** beyond listing: worktree creation/destruction is an
  engine/CLI concern (server only destroys on codebase delete, `api.ts:3157-3168`).
- **No endpoint to create/delete `remote_agent_sessions`** or to reset a conversation's AI session
  chain except by sending the `/reset` chat command through a conversation message.
- **Run output you can only get from the CLI/chat**: interactive gate *forms* with declared
  `decisions` exist only through `respond` (web) vs the CLI's richer review flows; terminal
  **container** isolation resume is CLI-only (`workflow-resume-service.ts:108-111`);
  `/internal/git-credential` is loopback-only; filesystem-level ops (edit `.archon/config.yaml`,
  install workflows into a repo, `register-project` with repo config) are CLI territory.
- **No auth tokens**: API identity is cookie (Better Auth) or trusted proxy header — no API-key
  auth for programmatic clients; CORS is open by default (solo assumption, `api.ts:1688-1690`).
- **SSE has no event replay by id / no named `event:` frames**; a client must treat REST as the
  source of truth and SSE as delta triggers (exactly what both UIs do).
- **Attribution is soft**: on solo installs nothing stops a caller with no identity from driving
  everything (rows get `user_id = NULL`).

---

## 9. Evidence index (key file:line)

- Boot / server wiring: `packages/server/src/index.ts:232-1097` (env `:6-42`, web adapter stack
  `:354-373`, dashboard poller `:375-389`, adapter registration `:405-676`, auth mount `:709-731`,
  API `:734`, webhooks `:737-835`, health `:838-855`, static `:857-874`, `Bun.serve` `:927-932`,
  continuation scheduler `:976-1003`, shutdown `:1006-1052`).
- REST configs: `packages/server/src/routes/api.ts:443-1581`; handlers `:1840-5069`;
  registerApiRoutes `:1586`; middleware (CORS `:1690`, auth gate `:1708-1716`, identity
  `:1734-1832`); openapi doc `:3261-3264`.
- SSE: `api.ts:2972-3005` (dashboard), `api.ts:3008-3047` (conversation); producers
  `adapters/web.ts:62-350`; transport `adapters/web/transport.ts`; persistence
  `adapters/web/persistence.ts`; bridge/payload map `adapters/web/workflow-bridge.ts:16-207,265-349`;
  truncation `adapters/web/truncate.ts:10-29`; cross-process poller
  `adapters/web/dashboard-event-poller.ts`, `pg-notify-listener.ts`,
  `packages/core/src/db/adapters/postgres.ts:22`.
- Auth: `packages/server/src/auth/config.ts`, `auth/instance.ts`, `auth/index.ts`; sidecar
  `auth-service/server.js:1-223`; webhooks `routes/webhooks.ts:24-49`.
- Client types/events: `packages/web/src/lib/types.ts:28-242`; api client
  `packages/web/src/lib/api.ts`; SSE hooks `hooks/useSSE.ts`, `hooks/useDashboardSSE.ts`;
  console SSE cache invalidation `experiments/console/lib/sse.ts:1-228`, `lib/http.ts:54-72`;
  app routes `App.tsx:66-124`; generated types pipeline
  `packages/server/src/scripts/generate-api-types.ts:7-31`.
- Schema: `migrations/000_combined.sql` (canonical; tables `:39-580`, indexes `:608-717`);
  per-file migrations `migrations/001…023`; embedded schema
  `packages/core/src/db/bundled-schema.generated.ts`, auto-apply
  `packages/core/src/db/adapters/postgres.ts:66-69`, SQLite parity
  `packages/core/src/db/adapters/sqlite.ts:207` + `sqlite.test.ts:541`.
- Deploy: `docker-compose.yml`, `Dockerfile` (web build `:43-51`, prod image `:57-201`),
  `docker-entrypoint.sh`, `Caddyfile.example`, `.env.example`.
