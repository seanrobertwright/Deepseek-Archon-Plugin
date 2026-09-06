# dsh-archon

> Objective: deeply understand [coleam00/Archon](https://github.com/coleam00/Archon)
> (reference docs at [archon.diy](https://archon.diy)) and build a plugin that makes
> **DSH (DeepSeek Harness) the visual layer / web UI for Archon**.

## Status

- **Deep-understanding phase complete** (round 1): four research reports in
  `docs/research/`; integration architecture in `docs/ARCHITECTURE.md`.
- **Decisions locked**: target = Archon **v0.10.1 source server** (REST/SSE API);
  surfaces = console/dashboard tab + run controls + Archon chat + DSH agent
  tools; mode = same-origin host relay.
- **M0 + M1 + M2 + M3 built and verified** (rounds 2–5): the plugin is an
  external bundle shaped exactly like the sibling plugins already linked into the
  live web profile. Host half reverse-proxies Archon under same-origin
  `/archon/*` (REST **and** live SSE) behind the DSH connection trust/auth gate;
  browser half registers an **Archon** conversation-view tab with two modes:
  **Console** (server health, registered projects, discoverable workflows,
  recent runs + run controls: launch; approve/reject/resume/cancel/abandon;
  live dashboard SSE) and **Chat** (pick/create a web conversation, stream the
  routing agent's replies + tool activity over per-conversation SSE, send
  messages). The host registers five **`archon_*` agent tools**
  (status/workflows/runs/run/control) so the DSH model can drive Archon from
  normal chat.
- **Live-GUI end-to-end verified** (round 7, `tests/gui-e2e.mjs`): authenticating
  to the running GUI proves the Archon tab is registered (boot graph injects
  `dsh-archon/client.js`), the served bundle carries the current M0/M1/M2 code,
  and `/archon/api/health` through the relay returns live Archon v0.10.1 JSON
  (15 conversations / 77 workflows / 3 real runs served through the same proxy).
  Every test suite in `tests/run-all.mjs` green.
- **Run detail drill-down + artifacts panel** (M-next-2 + M-next-3,
  `docs/plans/run-detail-artifacts.plan.md`): every Runs row carries a
  **Details** button that opens a side panel with the run header, the full
  event timeline (`GET /api/workflows/runs/{id}`), and the run's artifacts
  (`GET /api/runs/{id}/artifacts`); clicking a textual artifact previews it
  inline from `GET /api/artifacts/{id}/*`, while binary and over-cap files
  offer a raw link instead. Live dashboard SSE re-fetches an open panel.
  Client-only — the relay already proxies these read routes.
- **Real run lifecycle verified against the scratch Archon v0.10.1 server**
  (`:3090`): a `dsha-demo` run completed; a `dsha-gate` run paused at its
  approval gate and both **approve → completed** and **reject → cancelled**
  succeeded through the exact M1 write verbs; the **M2 chat path** (message
  dispatch → routing-agent reply → history) and the **per-conversation SSE
  stream** both relay correctly.
- **Installed into the live web profile — and the host row is LIVE without a
  restart** (`~\.dsh\profiles\web`): the dependency is linked and
  the loader row is inserted by the profile's **live patch layer** (the web
  profile hot-reloads `cordis.patch.yml`), so the running `dsh web` process
  mounted the `/archon` relay immediately. Verified: a forged-Host request to
  `/archon/api/health` returns **403** (this plugin's trust fence) while a
  nonexistent path returns 404; `--dump-config` composes exactly one archon row.
  A **browser refresh** loads the composed client row — see `docs/ACTIVATION.md`.
  Important: do NOT also add dsh-archon to `dsh.profile.bundles` (would insert
  the row twice); the profile patch is the single source.
- **Human-confirmed working** (round 10): refreshed the DSH GUI and verified the
  Archon tab renders with live Archon data. Objective achieved.

## Try it live

The plugin's host row is already live in the running GUI (the web profile
hot-applied the profile-patch insert — no server restart needed). **Refresh the
browser** at `http://127.0.0.1:3080` (hard-refresh if needed), then open any
session: an **Archon** tab appears beside Chat/Trajectory/Terminal, plus a ◆
sidebar icon. With an Archon v0.10.1 server reachable at
`http://127.0.0.1:3090` (override via `DSH_ARCHON_BASE_URL`), the tab shows live
server/project/workflow/run state and lets you launch and control runs.

To re-install from a clean profile (e.g. after moving the workspace):

```powershell
dsh plugin --profile web add <parent-dir>/dsh-archon   # NB: run from a path
# with no spaces, or edit package.json manually as the siblings do (see
# docs/ACTIVATION.md) — the `dsh plugin` path anchoring splits on spaces.
```

## Tests

```bash
node tests/run-all.mjs    # host smoke + client registration + relay loopback
# relay-loopback needs a live Archon API: either start one (see docs/research/02)
# or point DSH_ARCHON_BASE_URL at any running Archon server.
```

## Layout

```
lib/index.js            host entry: /api/dsh-archon/state + /archon relay + tools
lib/host/relay.js       same-origin reverse proxy (REST + SSE) to Archon
lib/host/archon-client.js  outbound Archon REST client (host side)
lib/host/tools.js       M3: archon_status/workflows/runs/run/control agent tools
lib/client.js           browser half: Archon console tab + sidebar tool (M0+M1)
cordis.patch.yml        loader patch: insert row id=archon -> this package
tests/                  run-all.mjs (smoke-apply, client-register,
                        run-detail-render, tools-live, chat-sse-live,
                        relay-loopback, gui-e2e)
docs/research/          deep-dive research reports (Archon + DSH)
docs/ARCHITECTURE.md    integration architecture + decisions + round state
docs/ACTIVATION.md      live-profile install state + restart checklist
```

## Important discovery: Archon changed shape

`coleam00/Archon` has been **completely rewritten since the famous 2025 Python
version**. The old Python "task management + RAG" Archon is preserved on the
`archive/v1-task-management-rag` branch. The current `main` (v0.10.x, this
checkout is v0.10.1) is a **Bun + TypeScript monorepo**: a self-hostable,
governed agentic-automation engine that runs YAML-defined DAG *workflows* that
mix deterministic nodes (`bash`/`script`), AI-agent nodes (Claude Code / Codex /
Pi / OpenCode / Copilot), human approval gates and loops — each run isolated in
its own git worktree, dispatched from CLI, Web UI, Slack, Telegram, GitHub,
Discord, or Gitea/GitLab.

Its own Web UI is explicitly a **reference implementation over public
contracts**, not a privileged product layer ([direction §Web UI](./_reference/Archon/.archon/direction.md#50)) —
Archon *invites* third-party UIs (like one built on DSH) against its REST/SSE API.

## Layout

- `docs/research/` — deep-dive research reports (4 domains).
- `docs/ARCHITECTURE.md` — integration architecture: how DSH becomes Archon's visual layer.
- `_reference/Archon/` — read-only shallow clone of Archon `main` (v0.10.1) for study.
- plugin scaffold — (next) an external DSH client plugin in the sibling-plugin
  shape used by `dsh-tmux-terminal`, `dsh-browser-sidebar`, etc.
