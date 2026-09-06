# Plan: Run detail drill-down + artifacts panel (M-next-2 + M-next-3)

## Summary

Add a run-detail drill-down to the dsh-archon DSH plugin's Console view: clicking a
row in the Runs table opens a detail panel showing the run's header (status,
timestamps, outcome) and its full event timeline; the same panel lists the run's
artifacts and lets the user preview textual artifact files inline. This closes the
plugin's biggest gap as Archon's visual layer — today a user can launch and steer a
run but cannot see what happened inside it or what it produced.

## Files to change

- UPDATE `lib/client.js` — the browser half (single-file bundle). Add:
  - Console state: `detailRunId`, `detailRun`, `detailArtifacts`, `detailLoading`.
  - `openRunDetail(runId)` / `closeRunDetail()` — fetch run detail
    (`GET /archon/api/workflows/runs/{id}` -> `{ run, events[] }`) and artifact list
    (`GET /archon/api/runs/{id}/artifacts` -> `{ files: [{ path, size, modifiedAt }] }`),
    store in state.
  - `renderRunDetail(s, patch)` — side panel with a header (workflow name, status,
    outcome, started/completed/last-activity) and a scrollable event timeline (each
    event: `event_type`/`type`, `node_id`/`step_name`, `timestamp`, truncated payload).
  - `renderArtifacts(...)` — rows of path/size/mtime; clicking a textual artifact
    fetches `GET /archon/api/artifacts/{runId}/{path}` (raw text response — the server
    serves file contents at this wildcard route) and previews it in a `<pre>` when the
    response is under ~64 KiB and looks textual, else shows a plain link/note.
  - A "Details" button per row in `renderRuns`, next to the existing control
    buttons, calling `openRunDetail(run.id)`; only enabled for runs.
  - When the dashboard SSE fires while a detail panel is open, re-fetch the open
    run's detail so live status flows into the panel.
  - New `dsha-detail-*` CSS rules appended to the CSS array.
- No host-side change required for read paths: `handleRelay` already proxies any
  `/archon/api/*` path, so the three GET routes are reachable from the browser.

## Step-by-step tasks

1. Add the state fields and the `openRunDetail`/`closeRunDetail`/`loadArtifacts`
   helpers in `ArchonConsole` (or a small `RunDetail` component within the same
   file, keeping the module-loader bundle format).
2. Add the "Details" button per run row.
3. Build `renderRunDetail` to show header + event timeline from `{run, events[]}`.
4. Build the artifacts sub-list with inline textual preview.
5. Ensure the dashboard-SSE handler refreshes an open detail view.
6. Run the checks below and fix until green.

## Validation Commands

The deliver run executes inside an isolated git worktree clone of this repository.
The project's live-GUI checks (`node tests/gui-e2e.mjs` and the rest of
`node tests/run-all.mjs`) drive the *running* DSH GUI, which serves the plugin from
the operator's live checkout — NOT from this worktree — so they cannot validate this
branch and must not be part of this run's gate. Run these worktree-truthful checks
instead (all operate on files in this checkout):

- `node --check lib/client.js`
- `node tests/smoke-apply.mjs`    (host entry shape — reads lib/ from this checkout)
- `node tests/client-register.mjs` (client bundle registers conversation.view +
  sidebar.workspaces.tools + settings.section under __ModuleLoader__; reads
  lib/client.js from this checkout)
- `node tests/relay-loopback.mjs` (host relay passthrough against the live Archon
  server; regression only — the feature adds no host code)

There is no package.json `scripts` block; run node commands directly. Do not add
dependencies. Do NOT modify tests/gui-e2e.mjs or tests/run-all.mjs to add markers
for this feature — the served live bundle cannot contain them during this run, so
doing so would make the operator's post-land GUI check fail for the wrong reason.
GUI verification of this feature happens after the branch lands in the operator's
live checkout.

## Acceptance criteria

- In the Console → Runs table, every row shows a "Details" button.
- Clicking it opens a panel with the run header and a readable event timeline
  (status, outcome, per-node/step events with timestamps).
- The panel lists that run's artifacts (path, size, mtime); text artifacts preview
  inline via the artifacts content route.
- The four validation commands above pass on this branch.
- `node --check lib/client.js` is clean.

## Explicitly out of scope

- Artifact download/save to disk; binary/zip artifact previews (plain link only).
- Editing/deleting runs from the detail panel (existing table controls remain).
- A visual DAG graph renderer — the timeline is text/structured for this pass.
