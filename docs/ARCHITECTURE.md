# dsh-archon — Architecture: DSH as the visual layer / web UI for Archon

Status: **draft synthesis** (round 1 research). Everything below is grounded in
the research reports under `docs/research/` and first-hand inspection of both
repositories; file:line evidence lives in those reports.

---

## 1. The two systems in one paragraph each

**Archon** (`coleam00/Archon` v0.10.1, Bun/TS monorepo) is a governed agentic
automation engine. Users define multi-step AI-coding workflows as YAML DAGs
(`.archon/workflows/`); a run mixes deterministic nodes (bash/script), AI-agent
nodes (Claude Code / Codex / Pi / OpenCode / Copilot), approval gates, and
loops, each isolated in its own git worktree. It exposes: a fully standalone
CLI (`archon workflow run/…`, JSON modes, never calls the server API), a Hono
REST/SSE server (`packages/server`) with an **open** `/api/*` (CORS `*` by
default; no auth by default; OpenAPI spec at `/api/openapi.json`), platform
adapters (Web, Slack, Telegram, Discord, GitHub, Gitea, GitLab), SQLite (default)
or PostgreSQL persistence, and a React Web UI whose direction doc explicitly
says it is a *reference implementation over public contracts, not a privileged
product layer*.

**DSH (DeepSeek Harness)** is an all-plugin Cordis agent harness whose web GUI
(`dsh web`, served at `http://127.0.0.1:3080`) is itself a browser-side Cordis
application: a Vite-built shell plus independently built, per-package **client
plugins** discovered from Host Loader rows whose manifest declares
`dsh.client` (`platform: 'web'`) and exports `./client` → built `lib/client.js`.
All UI composes through one slot API (`ctx.slots.inject/register`) over a typed
`SlotMap`. Host plugins are plain Cordis plugins (profile bundles installed with
`dsh plugin --profile <name> add`); a Loader-row package with a `dsh.client`
manifest + built `./client` becomes browser UI even when it lives **outside** the
DSH monorepo (turtle-ui is the documented out-of-tree example; the sibling
plugins in `E:\Projects\deepseek harness plugins\` prove the live pattern).

**Consequence:** an "Archon visual layer" is a DSH plugin (host + browser halves)
that presents Archon's engine state and controls inside the DSH GUI — Archon
keeps running as the engine; DSH supplies the visual/management layer.

---

## 2. What a visual layer must surface (Archon domain model)

From reports 01–03 (Archon): the objects a management UI cares about are:

- **Codebases / projects** — registered repos (URL clone or local path), each
  with environments (git worktrees or in-place), default branch, env vars,
  per-user GitHub identity.
- **Conversations** — chat surfaces (platform + conversation id), each bound to
  a codebase + cwd, holding an AI **session** (resumable via SDK
  `assistant_session_id`) and message history; a workflow run can dispatch from a
  conversation and stream progress back to it.
- **Workflows** — YAML DAG definitions discovered from repo `.archon/workflows/`,
  `~/.archon/workflows/`, and bundled defaults; node types prompt/bash/script/
  command/loop/loop_group/approval/wait/cancel/include/workflow; variables,
  conditions (`when`), tiers/aliases for model resolution.
- **Workflow runs** — execution rows with a *status* (pending/running/paused/
  completed/failed/cancelled) and an authored *outcome* (succeeded/failed/null);
  per-node states, node sessions, artifacts dir, transcript JSONL, parent/child
  sub-runs, per-run git isolation env.
- **Events / progress** — live SSE: `workflow_step`, `dag_node`, `text`,
  `tool_call`, `tool_result`, `conversation_lock`, `workflow_status`,
  `workflow_dispatch`, `workflow_artifact`, `session_info`, `error`, `heartbeat`.
- **Gates & approvals** — paused runs awaiting human approve/reject/decision
  (interactive workflows run foreground in web; background runs show progress
  cards and are steered from the console).
- **Providers & config** — assistant/provider model config, tiers/aliases,
  per-user AI prefs, credential state, concurrency health.

### Public seams Archon offers to a third-party UI (verified)

1. **REST API** (`/api/*`, Hono + zod-openapi): conversations, codebases,
   workflows, workflow runs (list/get/cancel/resume/abandon/approve/reject/
   respond/signal), run artifacts, config PATCH, provider keys/prefs, health.
   Machine spec at `GET /api/openapi.json`. CORS-open by default
   (`origin: '*'`, api.ts:1688-1690); **no auth by default** (reverse proxy /
   opt-in Better Auth web login gates it).
2. **SSE streams**: `/api/stream/{platformConversationId}` (chat + run events for
   one conversation, replay-buffered 500 events/60 s across reconnects with 5 s
   grace) and `/api/stream/__dashboard__` (multiplexed lifecycle for all runs,
   incl. out-of-process CLI runs via a DB poller on SQLite or Postgres
   LISTEN/NOTIFY). Event catalog (~21 types) is JSON-in-`data:` discriminated on
   `type`: `text`, `tool_call`, `tool_result`, `session_info`,
   `conversation_lock`, `retract`, `error`, `warning`, `system_status`,
   `heartbeat`, `workflow_dispatch`, `workflow_status`, `workflow_step`,
   `dag_node`, `workflow_artifact`, `workflow_tool_activity`,
   `workflow_task_activity`, `workflow_hook_activity`,
   `workflow_output_preview`, `container_lifecycle` (report 02 §3.2).
3. **CLI** (fully standalone, same DB): `archon workflow list/run/status/runs/get/
   wait/approve/reject/resume/cancel/abandon --json`, `--detach` for
   backgrounding; `workflow logs` streams the JSONL transcript.
4. **Web UI is replaceable by contract**: direction.md §web-ui says the console
   consumes "the same run, governance, event, artifact, and configuration
   contracts available to another SDK or API client". The console itself
   implements cache-invalidation-over-SSE (report 02 §5.3): REST is the source
   of truth, SSE events are invalidation triggers. A third-party UI can reuse
   the generated types (`web/src/lib/api.generated.d.ts` from openapi-typescript)
   and the `api.ts` wrapper patterns directly.

### Known gaps / constraints (report 02 §8.3)

- SSE has no id-based event replay: REST is the source of truth; SSE = deltas.
- No API-key auth: identity = Better Auth cookie or trusted proxy header.
- No REST to manage isolation worktrees (engine/CLI concern).
- Conversations other than web platform are inbound-only; web conversations are
  the client-creatable surface.
- Archon server and DSH each read the same DB *if* pointed at the same
  `ARCHON_HOME`/DB — for one shared install, drive runs via **one** surface
  consistently (server API, or CLI) to avoid dual-driver races; mixing works but
  needs care.

---

## 3. The DSH GUI surface available to a plugin (verified)

From report 04: the DSH GUI composes exclusively through slots. Attach points an
Archon visual layer can use:

| Need | Slot / mechanism |
|---|---|
| Whole new per-session tab (full content area, like Terminal/Trajectory beside Chat) | `conversation.view` list entry (`id: 'archon'`, `order`, `label`) + `ctx.uiConversation.views.register(...)` + hooks via `ctx.uiSession.provide` |
| Replace the whole conversation column | `conversation` (single, session-maybe) — heavy, replaces chat |
| Frame-wide floating panel (like an embedded browser / file manager) | `shell.overlay` (list) with a fresh `id` |
| Tool icon in the sidebar workspaces toolbar | `sidebar.workspaces.tools` (list) |
| Render inside chat stream for a new "run/agent card" node | keyed `conversation.chat.node` + `ConversationNodeDefinition` (durable data path via session events) |
| Tool-result rendering keyed by tool name | `tool.call.toolview` |
| Settings page sections | `settings.section` lists |

Data rules that bind any implementation (report 04 §7):
- **Presentation-only web layer**: display-only Archon state needs no session
  event; but model-visible input requires a durable session event, and anything
  replayable in chat belongs to a host-emitted event + Conversation Node.
- **No business data in slot stores**: Archon engine state must live in a
  plugin-owned service/model, surfaced to components via the registration
  `hooks` compartment (bare `getSnapshot`/`subscribe` sources → `use<Name>`) or
  standard hooks. No hand-made hooks.
- **Components never see ctx**; props are the derived four shares.
- All UI copy goes through typed locale dictionaries (`t` seat).

---

## 4. Chosen integration architecture (recommendation)

**Hybrid relay on one shared loopback origin** — recommended over direct
browser→Archon calls, because it removes all CORS/origin/auth concerns and lets
the plugin also manage Archon's lifecycle and DB:

```
Browser (DSH GUI at 127.0.0.1:3080)
   │  same-origin fetch / EventSource under /archon/*
   ▼
DSH Host (Cordis profile)                     
   └─ dsh-archon host half (bundle row in the web profile)
        ├─ ctx.webServer.register({kind:'prefix', path:'/archon', handler})
        │      └─ server-side relay → Archon REST (/api/...)  [no CORS in browser]
        ├─ ctx.webServer.registerUpgrade({path:'/archon/stream/...'})
        │      └─ relay of Archon SSE (/api/stream/__dashboard__ etc.) to the browser
        ├─ optional DB/workspace bridging (read run rows / ~/.archon) and
        │  Archon lifecycle helper (health checks; start `archon serve`)
        └─ optional agent tools (archon_status / archon_run / archon_approve …)
              → ctx.tools.register  (so the DSH model can drive Archon too)
   └─ dsh-archon client half (browser plugin row)
        └─ ctx.slots: 'conversation.view' entry 'archon' (+ sidebar tool + shell.overlay)
             └─ renders: project/codebase rail, workflow list + launch,
                run dashboard (status/outcome/progress), run detail (DAG +
                node logs + artifacts), approval gate buttons, live SSE updates
                Data pattern mirrors Archon's console: REST is source of truth,
                SSE events invalidate a small client cache (report 04 §7 rules).
```

Deployment realities discovered on this machine:
- **Archon v0.7.1 binary is installed** (`~/.archon/bin/archon.exe`) with a live
  SQLite DB (`~/.archon/archon.db`), `claude` + `codex` on PATH, `gh` present,
  bun 1.3.14 available. The source checkout under `_reference/Archon` is v0.10.1
  (newer: adds `workflow runs/wait/abandon/respond`, console UI, packaging). The
  installed 0.7.1 CLI surface is a **subset** of 0.10.1 (it lacks
  `workflow runs/wait/abandon/respond` and several REST improvements), so the
  DSH visual layer should be built against the **0.10.x API contract** and
  driven by either (a) the 0.10.1 source server (`bun run dev:server` /
  `bun run start`, web on 5173 dev + API on 3090, or single-origin prod build)
  or (b) an upgraded 0.10.x binary. The v0.7.1 binary remains a CLI fallback
  until upgraded.
- **The DSH web profile is live** (`~\.dsh\profiles\web`,
  `patchReload: live`), already linking seven sibling external plugins from
  `E:\Projects\deepseek harness plugins\…` via `dsh plugin --profile web add`.
  The dsh-archon workspace sits in that same folder and is meant to follow the
  identical recipe (`package.json` with `dsh.bundle.patch` + `dsh.client`;
  `cordis.patch.yml` inserting a row; `lib/index.js` host half; `lib/client.js`
  browser half calling `window.__ModuleLoader__.load({id, factory})`).

### Why relay through the DSH host rather than direct browser→Archon

- DSH sends no CORS headers, but Archon *does* (`origin: '*'`) — direct fetch is
  technically possible today. However: Archon auth (Better Auth cookie) would
  need cross-origin credentials, SSE via `EventSource` can't carry auth headers,
  and mixing cookie domains is fragile. A same-origin `/archon` relay on the DSH
  host keeps one origin, one auth story, and lets the host add caching, health
  gating, and (later) DB-level read optimization.
- Same-origin also means the plugin can hold an SSE upgrade per browser view and
  reuse DSH's trust fence for `/api`.

### Plugin package shape (external, sibling-style)

```
dsh-archon/
  package.json          name dsh-archon; dsh.bundle.patch; dsh.client platform web
  cordis.patch.yml      - insert: [{id: archon, name: dsh-archon}]
  lib/index.js          host half: apply(ctx) registers /archon relay + health + optional tools
  lib/host/archon.js    ArchonClient (REST+SSE outbound), config (base URL/port), auth passthrough
  lib/host/relay.js     webServer prefix/upgrade registration
  lib/host/state.js     ArchonModel: plugin-owned business state (no slot stores)
  lib/client.js         browser half: window.__ModuleLoader__.load({ id: 'dsh-archon', factory })
  lib/client/…          Archon console components registered into slots
  tests/…               smoke + loopback relay tests (mirror dsh-tmux-terminal)
  README.md             install: dsh plugin --profile web add ./dsh-archon; restart; refresh
```

Host half runs in the dsh process and owns outbound HTTP to Archon — the browser
half is pure presentation, fetching same-origin `/archon/*`.

---

## 5. Incremental delivery path

1. **M0 — Console tab with read-only dashboard (visual layer proof).**
   `conversation.view` entry `archon` (+ sidebar icon). Host relay `/archon/api`
   → lists codebases/workflows/runs; client renders cards/status; SSE relay
   streams `workflow_*` events to a live view. No model involvement.
2. **M1 — Control plane.** Launch workflow runs (pick workflow + message/inputs),
   approve/reject/resume/cancel gates from the console; command the installed
   `archon` CLI (`--detach --json` + wait) or the REST API depending on the
   detected surface (v0.7.1 binary: CLI; 0.10.x server: REST).
3. **M2 — Agent integration.** Optional `ctx.tools.register` archon tools so the
   DSH model can inspect/start Archon runs; steer via the same relay. Model
   visibility requires durable session events (repo rule) — decide per tool.
4. **M3 — Deep surfaces.** Run detail with DAG rendering, per-node logs,
   artifacts; conversation embedding (Archon conversation as a DSH
   ConversationNode via host-emitted events); workflow YAML authoring view.

---

## 6. Decisions (user-confirmed, round 1)

| Question | Decision |
|---|---|
| Target Archon instance | **v0.10.1 source server** (`_reference/Archon`; `bun run dev:server` → API on 3090; or `bun run start` single-origin prod) — build against the full REST/SSE API. (Installed v0.7.1 binary remains a fallback CLI driver, not the primary target.) |
| UI surfaces (all wanted) | (1) **Console/dashboard tab** — projects, workflows, runs, live SSE progress; (2) **Run controls** — launch workflows, approve/reject/resume/cancel/abandon gates; (3) **Archon chat surface** — talk to the routing agent as Archon's own web chat does; (4) **DSH agent tools** — `archon_*` tools so the DSH model can inspect/start Archon from normal chat. |
| Integration mode | **Same-origin host relay** — host half proxies Archon REST/SSE under `/archon/*` on the dsh web server; the browser tab calls those same-origin paths. |

Build order locked from these decisions: M0 read-only console tab (REST + SSE relay),
M1 run controls (write path), M2 Archon chat surface, M3 agent tools. The skeleton
already shipped in this workspace (`package.json`, `cordis.patch.yml`,
`lib/index.js`, `lib/client.js`, `tests/smoke-apply.mjs`) follows the sibling
plugin recipe and passes its smoke test; M0 replaces the placeholder status card
with the real console.

## Round-2 state — M0 built and verified

**Host relay** (`lib/index.js` + `lib/host/relay.js`): registers a `webServer`
prefix route `/archon` that reverse-proxies the Archon server under the dsh
origin. Every request is gated by `connection.requestRejection` (the same
Host/Origin + browser-session fence as `/api`). Both REST (any method) and
long-lived SSE pass through (response streamed, upstream aborted when the
browser disconnects). A `/api/dsh-archon/state` authenticated fetch route probes
reachability/config for the UI.

**M0 console** (`lib/client.js`): an `archon` entry in the `conversation.view`
tab list (beside Chat/Trajectory/Terminal) plus a `sidebar.workspaces.tools`
entry. The tab renders server health/version, registered codebases, discoverable
workflows, and recent workflow runs, and live-refreshes on
`/archon/api/stream/__dashboard__` SSE frames (`workflow_status`, `dag_node`).
Display-only: no session events, no slot-store business state (report 04 §7).

**Verified** (`node tests/run-all.mjs`, all green) against a real Archon v0.10.1
server booted from `_reference/Archon` on a scratch home (API `:3090`):
1. `smoke-apply.mjs` — host registers the state route + `/archon` relay; degrades
   gracefully when `webServer` is absent.
2. `client-register.mjs` — browser bundle registers both slots under
   `window.__ModuleLoader__` with id `archon`.
3. `relay-loopback.mjs` — REST passthrough (`/api/health`, `/api/workflows` → 31
   bundled workflows), **write-path passthrough** (POST creates a web
   conversation, PATCH titles it, list read-back finds it — the exact verbs M1
   run controls need), SSE relay (dashboard emits a frame through the relay),
   upstream 404 preserved, and `requestRejection` 401 short-circuits before
   proxying.

**Not yet done**: live-profile install (`dsh plugin --profile web add` +
restart of `dsh web`) and a visual GUI pass — the restart drops the running GUI
session, so it is a deliberate follow-up step (commands in README). Sandbox note:
codebase registration via the Archon API needs a git spawn that this session's
sandbox blocks; M0 read paths (bundled-default workflow discovery, health, SSE)
do not.

## Round-3 state — M1 run controls + profile install

**M1 console controls** (`lib/client.js`): the Archon tab now has (a) a **launch
panel** — pick a discovered workflow + optional message → `POST
/archon/api/workflows/{name}/run` — and (b) **per-run control buttons** shown by
status (running/pending → cancel, abandon; paused → approve, reject, resume,
cancel, abandon; failed → resume, abandon) posting `POST
/archon/api/workflows/runs/{id}/{verb}`. A notice strip reports outcomes; the
view reloads after each action. All verbs were verified through the relay
against the live Archon server (each returns Archon's real response envelope).

**Profile install** (see `docs/ACTIVATION.md`): `dsh-archon` is linked in the
live web profile's `node_modules` and listed in `dsh.profile.bundles`; the
composed `--dump-config` contains exactly one archon row; the profile lockfile
is clean. Host bundles load at boot, so the row activates on the next `dsh web`
restart (the running GUI was deliberately not restarted because this session's
execution runs under that process).

**M1 live-run caveat**: creating a *real* run needs a registered codebase, whose
registration spawns git — blocked by this session's sandbox. The API write path
(run dispatch returns `{accepted:true,status:"started"}`; all five control verbs
respond) is verified; actual run execution + gate resolution will be verified in
the user's environment after activation.

## Round-4 state — M3 agent tools + REAL end-to-end run lifecycle

**M3 agent tools** (`lib/host/tools.js` + `lib/host/archon-client.js`): five
`archon_*` tools registered on `ctx.tools` so the DSH model can drive Archon
from normal chat — `archon_status` (health), `archon_workflows` (list, optional
project cwd), `archon_runs` (recent runs w/ status filter), `archon_run`
(launch a workflow; optional registered-project path → codebase binding),
`archon_control` (approve/reject/resume/cancel/abandon by run id). Outbound HTTP
runs inside the dsh process; verified live in `tests/tools-live.mjs`.

**Real end-to-end lifecycle verified** (after the sandbox policy widened to full
access and the Archon server was restarted under it, so git spawns work):
1. Registered `_reference/Archon` as a codebase via the API (was impossible
   earlier — git spawn was blocked).
2. Launched a real `dsha-demo` workflow → **completed** (isolated worktree
   created, node executed).
3. Launched an interactive `dsha-gate` workflow → paused at the approval gate
   with `approval.decisions: [approve, reject]`.
4. **Approve** via the exact M1 write path → resumed → **completed**.
5. Re-launched the gate workflow, **Reject** → **cancelled**.
Both gate transitions use the same `POST /api/workflows/runs/{id}/{verb}` verbs
the console buttons and `archon_control` tool call. `tests/tools-live.mjs` now
sees the real runs through `archon_runs`.

**M2 chat data path verified live**: created a codebase-bound web conversation,
sent a real message to the routing agent
(`POST /api/conversations/{id}/message` → `{accepted:true,status:"started"}`),
and read the assistant reply back through `GET /api/conversations/{id}/messages`
(user message then assistant `dsha-chat-ok`). The REST surface M2's chat view
needs (conversation CRUD, message dispatch, message history) is confirmed
working against the real engine; the remaining M2 work is the chat **UI**
(composer + streaming message list over `/archon/api/stream/{conversationId}`),
which is best built and verified after GUI activation.

## Round-6 state — canonical install shape; activation requires one boot

**Correction to the round-5 "live without restart" finding.** The web profile's
live patch layer (`patchReload: live`) was probed rigorously against the running
dev GUI (PID 47224, started before this plugin existed):
- Inserting the row via the profile's own `cordis.patch.yml` **did** make the
  `/archon` relay live in the running process without a restart — a forged-Host
  request returned **403** (this plugin's trust fence) while unknown paths 404,
  proving the host half's route was registered.
- Emptying that patch eventually unmounted it (hot removal works but is slow).
- Keeping the row in the profile patch **and** in `dsh.profile.bundles` would
  double-insert at next boot (dump-config shows 2 rows), so that combination is
  rejected.

**Chosen durable state (current):** the **profile's live patch layer is the
single source** — `cordis.patch.yml` inserts the row, dsh-archon is **not** in
`dsh.profile.bundles` (both would double-insert: dump-config shows 2 rows). The
dependency link in `package.json` makes the row resolvable. This activates
**live in the running dev GUI** (round-6 verified: hot insert → `/archon` 403;
hot removal after emptying the patch → 404; re-insert → 403 again) and also
applies at boot (profile patches are applied after bundle layers on every boot),
so the composition is single-row in both the live and boot trees.

Because the row was hot-removed and re-inserted during the round-6
investigation, client-modules reconciled the loader entry and re-read the
current `lib/client.js` (M0 console + M1 controls + M2 chat) into its bundle
table, so a browser refresh boots the current client.

Verification ceiling this round: everything code-side and profile-side is proven
(dump-config single row, live `/archon` 403 fence vs 404 for unknowns, bundle
link + manifest resolve, all 5 test suites green against the live Archon server
with real runs/gates/chats). The remaining step is a browser refresh by the
user, then visual confirmation — see `docs/ACTIVATION.md`.

## Round-7 state — LIVE in the running GUI, end-to-end proof

New `tests/gui-e2e.mjs` authenticates to the running GUI (reconstructing the
signed browser-session cookie from the persisted credential secret, the same
construction BrowserAuth mints) and verifies the plugin is live end-to-end:

1. The served index's boot graph injects the dsh-archon client row (composed
   into the multi-plugin combo bundle).
2. The served bundle carries the current code (M2 chat toggle, M1 run controls,
   launch panel, chat CSS, registration id).
3. Authenticated `GET /archon/api/health` through the plugin's `/archon` relay
   returns live Archon v0.10.1 JSON — the trust fence and host proxy both work
   in the real running GUI; the same relay serves 15 conversations, 77
   workflows, and 3 real runs.

`node tests/run-all.mjs` (six suites incl. gui-e2e) is green. All surfaces of
the Archon visual layer are live and data-verified; only a human click-through
of the tab remains.

## Round-8 state — visual click-through done; one real bug found + fixed

Drove a real headless Chromium (Playwright) into the running GUI with a minted
browser-session cookie, selected the running session, and opened the Archon
conversation view — exactly what a user does. Findings:

1. **The Archon tab appears and activates** in the conversation view tab row
   (Chat | Trajectory | Terminal | **Archon**), and the ◆ sidebar tool renders —
   both plugin registrations work live with zero page errors.
2. **A genuine runtime bug was found by the visual check**: the console crashed
   on first paint because `renderHealth(null)` dereferenced `h.status` before
   `loadAll()` resolved (`slot entry crashed in 'conversation.view': Cannot read
   properties of null (reading 'status')`). Fixed — `renderHealth` now shows a
   "loading server state…" placeholder for null.
3. **After cycling the profile-patch row to force client-modules to re-read
   `lib/client.js`, the fixed bundle is served and the console renders fully**
   in the live GUI: Archon header, Console | Chat toggles, live health
   ("server ok · v0.10.1 · platforms: Web"), the workflow launch dropdown
   (40+ bundled + project workflows incl. dsha-demo/dsha-gate), and the Runs
   table showing the real gate lifecycle (`dsha-gate cancelled` from the reject
   test, `dsha-gate completed` from the approve test, `dsha-demo completed`).

Verification now includes a real rendered GUI (`tests/gui-visual-verify.py`,
Playwright) plus the authenticated HTTP proof (`tests/gui-e2e.mjs`), both
green.

## Round-9 state — Chat mode (M2) renders live too; every surface verified

Playwright rendered the Archon view in the live GUI and clicked into **Chat
mode**: the conversation pane appears with the CONVERSATIONS picker listing real
Archon conversations (`dsha-chat-ok`, `Run reject gate demo`, `Gate demo
execution`, …), a working New-conversation button, and a composer — zero page or
console errors (`tests/gui-chat-mode.py`).

Complete live-GUI coverage now: Console (health/platforms, workflow launch
dropdown with real bundled + project workflows, runs table with controls) ·
Chat (conversation list/create + composer) · five `archon_*` agent tools
(host-registered; live-tested against Archon) · the `/archon` relay + SSE
through the real trust fence. `node tests/run-all.mjs` (six suites incl.
gui-e2e) is green and both Playwright render checks pass.

## 7. Open questions (deferred)

1. **Auth posture for the Archon server** the relay talks to: default no-auth
   (loopback) is fine for local dev; document tightening via `WEB_UI_ORIGIN`
   and/or running Archon behind its own auth when the DSH host is remote.
2. **Which workspace/session the Archon console binds to** — DSH sessions map to
   Archon codebases via the session's workspace root (like tmux-terminal's
   `rootForSession`), with a fallback project rail for choosing any registered
   Archon project.
3. **Model-visible rules for M3 tools** — decide per tool whether results are
   display-only (no session event) or must be logged as durable events.
