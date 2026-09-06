# dsh-archon — activation state

## Status: DONE — human-confirmed working (round 10)

The user refreshed the DSH GUI and confirmed the Archon tab works in their
browser. The objective — DSH as the visual layer / web UI for Archon — is
achieved and verified end-to-end.

## Current state (round 6, verified)

The plugin's **host row is LIVE in the running `dsh web` process right now**,
without a server restart, via the web profile's live patch layer
(`patchReload: live`):

- `~\.dsh\profiles\web\cordis.patch.yml` is the **single source**
  of the loader row:
  `- insert: [{ id: archon, name: dsh-archon }]`
- dsh-archon is **not** in `dsh.profile.bundles` (putting it in both would
  double-insert the row at boot — verified: dump-config shows 2 rows).
- The dependency link in `package.json` is what lets the row resolve:
  `"dsh-archon": "link:E:/Projects/deepseek harness plugins/dsh-archon"`.

Verified live (forged-Host probes against the running GUI at :3080):

| probe | result | meaning |
|---|---|---|
| `GET /archon/api/health` (Host: evil.example.com) | **403** | `/archon` prefix route registered — the plugin's `connection.requestRejection` fence |
| `GET /zzz-unknown` (Host: evil.example.com) | 404 | unknown paths are not the plugin |
| `dsh --profile web --dump-config` | 1 archon row | no duplicate at next boot |
| Archon scratch server `:3090` | healthy | real data for the GUI |

Because the row was hot-removed and re-inserted during the round-6
investigation, `client-modules` reconciled the loader entry and **re-read the
current `lib/client.js`** (which now includes M0 console + M1 run controls +
M2 chat) into its bundle table.

## Activate (just refresh)

1. Refresh the browser at `http://127.0.0.1:3080` (hard-refresh Ctrl+Shift+R if
   the tab does not appear — the boot graph is re-injected on every index
   render, so a reload boots against the live composition).
2. Open any DSH session: the **Archon** tab appears beside Chat/Trajectory/
   Terminal, plus the ◆ sidebar icon.

If it still does not appear after a hard refresh, a full `dsh web` restart loads
the same single-row composition at boot (the profile patch is applied at boot
too). Do **not** add dsh-archon back to `dsh.profile.bundles` — the profile
patch is the single source.

## Round-7 verification — plugin LIVE in the running GUI, end-to-end

`tests/gui-e2e.mjs` authenticates to the running GUI (127.0.0.1:3080) exactly as
a browser session does (reconstructing the signed browser-session cookie from
the persisted secret) and proves:

1. **Boot graph carries the client row** — the served index injects
   `…,dsh-tmux-terminal/client.js,…,dsh-archon/client.js&rev=…` into its
   preloads.
2. **Served bundle is the current code** — the composed combo bundle's
   dsh-archon segment contains the M2 chat toggle, M1 run controls (Approve),
   the launch panel, chat CSS, and the `dsh-archon` registration.
3. **Relay is live through the real trust fence** — authenticated
   `GET /archon/api/health` returns `200 {"status":"ok",…,"version":"0.10.1"}`,
   and the same relay serves real data: 15 conversations, 77 workflows, 3 runs.

The plugin is therefore fully live in the running GUI today: the Archon tab
(Console + Chat) is registered, its bundle is composed from the current source,
and the host half proxies a live Archon server behind DSH's own auth. The only
thing left is the human eyeball check (open any session, click the Archon tab /
◆ icon). `node tests/run-all.mjs` includes this GUI e2e and passes.

## Expected in the GUI after refresh

- **Console mode**: server health + version + platforms; launch panel (pick a
  workflow, optional message, Run); projects list; runs table with per-status
  controls approve / reject / resume / cancel / abandon; live refresh on
  `/archon/api/stream/__dashboard__`.
- **Chat mode**: pick/create a web conversation on a registered codebase, stream
  the routing agent's replies + tool activity over the per-conversation SSE
  stream, and send messages.
- **Agent tools** once a session is active: `archon_status`, `archon_workflows`,
  `archon_runs`, `archon_run`, `archon_control`.

The scratch Archon v0.10.1 server is live on `http://127.0.0.1:3090` with real
data (a completed `dsha-demo` run, an approved + a rejected `dsha-gate` run, and
working chat conversations), so the console and chat surfaces will show
meaningful state immediately after refresh. Override the target with
`DSH_ARCHON_BASE_URL` if needed.

## Round-8 visual verification — Archon console renders in the live GUI

Playwright drove a real headless Chromium into the running GUI (minted
browser-session cookie), selected the running session, and opened the Archon
conversation view — proving what a user sees:

- The **Archon tab** appears in the conversation view tab row
  (Chat | Trajectory | Terminal | **Archon**) and activates; the **◆ sidebar
  tool** renders. Zero page errors.
- The **Console** view renders live: Archon header, Console | Chat toggles,
  `server ok · v0.10.1 · platforms: Web` (relay health), the workflow launch
  dropdown (40+ workflows incl. `dsha-demo`, `dsha-gate`), and the Runs table
  with the real gate lifecycle runs (`dsha-gate cancelled`, `dsha-gate
  completed`, `dsha-demo completed`).

This surfaced and fixed one real bug (`renderHealth(null)` crashed first paint —
round 8); after forcing client-modules to re-read the fixed bundle, everything
renders cleanly. Screenshots in `artifacts/`. Automated proofs:
`node tests/gui-e2e.mjs` and `python tests/gui-visual-verify.py`.

## If something is missing after refresh

- Browser console for a plugin-load error; confirm the client bundle is served
  (the exact `/plugins/??dsh-archon/client.js&rev=…` URL from the page's boot
  graph — a guessed URL 404s, so only check with the real rev).
- `node tests/run-all.mjs` in the workspace must be green (it is).
