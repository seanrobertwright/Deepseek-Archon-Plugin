# DSH Web client plugins: architecture, slots, recipes, and data paths

**Research report for an external web-UI surface (Archon visual layer) inside the DeepSeek Harness GUI.**

- Monorepo inspected: `E:\deepseek-harness` (all paths below are relative to it unless absolute).
- Everything under `packages/client/`, `apps/web`, `packages/bundle/web-app`, and the subsystem docs was read or located with `read`/`glob`/`grep` (no files under `E:\deepseek-harness` were modified).
- All file:line references are to the current checkout.

---

## 1. DSH web GUI big picture

### 1.1 What the browser application is

The GUI is a **browser-side Cordis application**, not a plain React SPA. The Host (`dsh web`, a Node process running a Cordis plugin tree composed from layers) serves an `index.html` shell plus **two kinds of browser code**:

1. **The shell** — `apps/web` is a thin Vite entry (`src/main.ts` calls `new AppWebEntry(el).run()`; apps/web/package.json:1-58) over the shell library `@deepseek-ai/dsh-client-web` (`packages/client/web`). It is compiled with Vite into `apps/web/dist` (vite.config.ts:140-229) and statically links a handful of platform libraries (react, cordis, `client/store`, `ui-primitives`, `ui-slots`), which are *not* runtime-bundled plugins.
2. **Client plugins ("dsh.client" rows)** — one independently built browser bundle per package, registered in package.json with a `dsh.client` manifest (`platform: "web"`), exported at `exports["./client"]`, and compiled to `lib/client.js` by a shared tsdown preset (`packages/client/tsdown.client.ts`). Each is served at runtime by the Host under `/plugins/??<pkg>/client.js,...&rev=…` and materialized by a browser module loader.

The composition metaphor (Cordis): "Every part of the product is a plugin… there is no privileged core to patch" (docs/architecture.md:11-13).

### 1.2 Boot flow

`docs/subsystems/web-client.md:20-24` summarises it; the implementation is `packages/client/web/src/boot.ts`:

1. The Host's `dsh.client.modules` node half scans its **Loader entries** for packages declaring `dsh.client`, composes a `WebBootGraph`, and injects it into every served index as `globalThis["__DSH_BOOT__"]` plus script tags for combo bundles (`packages/client/modules/src/index.ts`; docs/subsystems/client-modules.md:11-12, 73-85). It also installs `window.__ModuleLoader__` (the browser module facade).
2. `AppWebEntry.run()` (boot.ts:46-85) awaits `__DSH_BOOT_READY__`, reads `win.__DSH_BOOT__`, builds `ClientModuleSystem` with `staticModules: getStaticModules()` (boot.ts:55-74; `packages/client/web/src/seed.ts:23-37`), prefetches `immediately` rows, then `ctx.plugin(Loader)` and creates one plugin entry per graph row (boot.ts:113-135). Cordis service injection decides activation; `loader.internal = modules` wires the module table into the Loader (boot.ts:116).
3. After every entry is active (`assertEntriesActive`, boot.ts:138-158), the app mounts through a dependency fiber: `ctx.inject(['uiRenderer'], scope => scope.uiRenderer.mount(container))` (boot.ts:96-101). `ui-renderer` calls the sole context-level `ctx.slots.renderSlot('root', {})` and renders the tree (docs/subsystems/slots.md:15).

The index page is served by `dsh-host-frontend-static` (SPA fallback seat) which delegates root/index to `ctx.connection.authorizeIndex` — the loopback browser-session cookie exchange (`packages/client/connection/README.md:33-39`). Boot URL by default is `http://127.0.0.1:3080` (packages/bundle/web-app/cordis.patch.yml:120-121; apps/cli/reference/README.md:80).

### 1.3 What "client plugin" means concretely (manifest, exports, outputs)

Model package: `packages/client/ui-workspace/package.json` (and skeleton `ui-sidebar/package.json`):

- **Manifest**: `"dsh": { "client": { "inject": [<package names>…], "platform": "web" } }`. `inject` lists *informational* package-name edges (preflight/HMR diffing only — never apply sequencing; ui-workspace src/client/index.ts:56-60, packages/client/AGENTS.md:140). `platform: "web"` always; the scan throws without a `./client` export (AGENTS.md:140).
- **Exports**: `.` (node-half lib), `./invariant`, `./client` (browser bundle: `./lib/client.js`), `./src/*`, `./package.json` (ui-workspace package.json:16-31).
- **Build outputs**: `lib/index.js` (host/node half), `lib/invariant.js`, `lib/client.js` (the browser half closure factory that calls `window.__ModuleLoader__.load({id, factory})`; packages/client/tsdown.client.ts:1-10), `lib/types/**/*.d.ts`.
- **Scripts**: `"bundle": "tsdown"`, `"watch": "tsdown --watch"` (ui-workspace package.json:48-51). The config is one line: `clientBundle('@deepseek-ai/dsh-client-ui-workspace', ['lib/types/index.js', 'lib/types/invariant.js'])` (ui-workspace/tsdown.config.ts:1-3).
- **Two halves, one package**: `src/index.ts` is the *node half* — for pure UI plugins an empty `export function apply(): void {}` so the package appears as a Host Loader entry (ui-workspace/src/index.ts:1-9). `src/client/index.ts` is the browser entry exporting `inject` (service names) and `apply(ctx)` (registration body). Cordis activates the browser halves as plugins too — the client is itself a small Cordis application with services (`ctx.sessions`, `ctx.workspaces`, `ctx.slots`, `ctx.locale`, `ctx.layout`, `ctx.uiSession`, `ctx.uiConversation`, `ctx.remote.*`).
- **files**: `lib/index.js`, `lib/invariant.js`, `lib/client.js`, `lib/types/**/*.d.ts` (ui-workspace package.json:82-87).

`PLATFORM_MODULES` (the shared/frozen module table keys) = `['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis','@deepseek-ai/dsh-client-store','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-primitives']`; `PRELOADED_CLIENT_EXTERNALS` is empty in the shipped tree (packages/client/web/src/platform.ts:8-17). "Baseline externals are implicit for every dynamic bundle. Do not repeat React, Cordis, client/store, ui-primitives, or ui-slots in package manifests." (packages/client/AGENTS.md:76-81).

---

## 2. The slot system: how UI attaches

### 2.1 Registration contract (the *only* API)

- `SlotMap` is a compile-time, empty-by-default registry that owners extend by declaration merging (`packages/client/ui-slots/src/index.ts:26`). Each key declares `{ kind, scope, owner?, keyProps?, hookContext?, inject? }` (index.ts:102-124).
- Runtime registration: one `ctx.slots.register({ name, children?, store?, inject?, locale?, …kind options }, Component)` call contributes the component **and** declares child slots, a store seat, and the registrant business face. Registering into an undeclared slot, or declaring a key already declared by another entry, fails loud at activation (index.ts:705-894; docs/subsystems/slots.md:11-17).
- `ctx.slots.inject(name, () => ctx.slots.register(...))` waits for the target slot's declaration lifetime, so activation order is never assumed (ui-workspace/src/client/index.ts:138-159; ui-user-questions/src/client/index.ts:94-103).
- `root` is the only built-in declaration (seeded in `SlotCore`, index.ts:664-702) and the only slot rendered by the shell (`ctx.slots.renderSlot('root', {})`). `ui-layout` registers `AppFrame` into `root` and in the same call declares the four top-level child slots (packages/client/ui-layout/src/client/index.ts:119-147).
- The renderer service is `SlotRegistry` registered as Cordis service `'slots'` (packages/client/ui-renderer/src/client/registry.ts:134); the pure core is `SlotCore` in `ui-slots`. `ui-renderer` alone binds observables to hooks (uSES) and owns React contexts (docs/subsystems/web-client.md:60).
- Component props are four *derived* shares: `PropsRuntime<K>` (SlotMap owner + scope standard props) & `PropsRenderSlots<S>` (declared children, giving a typed `renderSlot`/`renderSlotChain`) & `PropsStore<H>` (`useStore` + `actions`) & the injected business face, plus `PropsLocale` for `t` (index.ts:440-448; packages/client/AGENTS.md:13). Components never receive `ctx`.
- Cardinality: `single | list | keyed | chain`; scope: `root | session-maybe | session` (index.ts:89-93). Standard kit per scope: every scope gets `useSessions`, `useSessionPendingInteraction`, `useWorkspaces`; session scope adds `sessionId`, `useSession`, `useProjection`, `useConversation`, `useInput`, `inputActions`, `useChat`, `useTrajectory` (docs/subsystems/slots.md:77-94).

### 2.2 Enumerated shipped slots where new UI can register

Top-level (declared by the ui-layout `root` entry; ui-layout/src/client/index.ts:36-88):

| Slot | kind / scope | Meaning / occupancy rule |
|---|---|---|
| `sidebar` | single / root | Whole left column. Occupied by ui-sidebar; registering here **replaces** the column. |
| `conversation` | single / session-maybe | Whole center column (hero + conversation). Occupied by ui-conversation; registering here **replaces** the whole conversation surface. |
| `details` | single / session | Right details column; occupied by ui-chat's DetailsPanel (declares `conversation.details.tool`). |
| `shell.overlay` | list / root | Frame-wide floating layer, above columns, additive (`id` per entry). Comment: "This is the additive seat for a frame-wide surface of your own". |

Sidebar interior (declared by ui-sidebar's SidebarRoot registration; ui-sidebar/src/client/index.ts:57-61, contract in ui-sidebar/src/client/contract/slots.ts:17-46): `sidebar.brand.mark` (single), `sidebar.brand.name` (single), `sidebar.workspaces` (single; occupied by ui-workspace's WorkspaceBrowser), `sidebar.settings` (single), `sidebar.footer.action` (list). Under the workspace browser (declared by ui-workspace, contract/slots.ts:60-69): `sidebar.workspaces.directoryFlow` (single). (An earlier local harness edit added a `sidebar.workspaces.tools` list here; it was reverted, so plugins use `sidebar.footer.action` for sidebar icons.) Settings drawers (declared by ui-settings + feature packages; ui-settings/src/client/contract/slots.ts): `settings.trigger/header/action/close/section/onboarding`, `settings.general.item` (list), `settings.plugins.tab` (list), `settings.plugin.item` (keyed), `settings.models.footer` (list), plus the models provider card and agent-preset seats merged by the owning feature packages.

Conversation surface (declared by ui-conversation's ConversationRoot children, apply.ts:201-212 and contract/slots.ts:93-147): `conversation.session` (single/session), `conversation.session.header` (single) with nested `conversation.session.header.lineage` (single), `conversation.session.header.actions` (list), `conversation.session.header.utilities` (list); `conversation.view` (**list / session** — the view *tabs*: `chat`, `trajectory`; a new id = a new full conversation target); composer seats `conversation.composer` (chain / session — e.g. ui-user-questions contributes a selector-routed entry), `conversation.composer.bar`, `conversation.input.overlay` (list), `conversation.input.dock` (list), `conversation.composer.dock` (list), `conversation.input.left/right` (lists), `conversation.input.attachments`, `conversation.input.plan`, `conversation.input.model`; hero seats `conversation.hero.brand.mark`, `conversation.hero.workspace` (+ its `conversation.hero.workspace.directoryFlow`), `conversation.hero.agentPreset`.

Chat/tool interiors (declared by ui-chat and ui-tool):

- `conversation.chat.node` — **keyed / session**, `keyProps` per `ChatNodeKind`, slot-level inject face `ChatNodeTurnDataInjected` providing the `useTurnData(key)` hook (ui-chat/src/client/contract/slots.ts:167-180; the inject factory is at ui-chat/src/client/apply.ts:35-46). This is *the* extension point for a new node type inside the assistant chat stream. Docs example: a "review job" node definition (`docs/subsystems/conversation.md:107-217`).
- Under it: `conversation.chat.commandview` (keyed), `conversation.chat.turnTail` (chain), `conversation.chat.assistant-actions` (list), `tool.call.toolview` (keyed by **wire tool name**, scope session; ui-tool/src/client/contract/slots.ts:10-27). `tool.view.cordis` and the built-in tool views register keys here (ui-tool/src/client/apply.ts:33-56); the docs tree also lists `tool.view.cordis`.
- `conversation.message.images` (single), `conversation.trajectory.images` (single), `conversation.approval.detail` (single), `conversation.details.tool` (single — whole details-panel body for a selected tool call).

**New-surface guidance** (most relevant for an Archon visual layer):

- A *full replacement* of a column: register into `sidebar` or `conversation` (`single`, replaces occupant + its declared children).
- A *whole extra conversation target/tab* per session: register `conversation.view` list entry (`id: 'archon', order, label`) **plus** a conversation target builder registered on `ctx.uiConversation.views.register(...)` and a hook published through `ctx.uiSession.provide(...)` — exactly how ui-trajectory adds the Trajectory tab (ui-trajectory/src/client/index.ts:47-107; ui-conversation/src/client/conversation/view-registry.ts:12-19; ui-chat/src/client/apply.ts:98-151).
- A *node inside the chat flow* driven by live (non-durable) data: keyed `conversation.chat.node` renderer; but per the Conversation rules, Chat-node content that must survive reload comes from durable session events via a `ConversationNodeDefinition` (see §7).
- An *additive frame-wide surface*: `shell.overlay` with a fresh `id`.
- Tool-result rendering: keyed `tool.call.toolview`.
- Sidebar footer: the `sidebar.footer.action` list (icons beside Settings).

A running page can query the live tree with `cordis_inspect what:"client"`; the source catalog is regenerated by `pnpm run gen-client-catalog` (docs/subsystems/slots.md:165).

---

## 3. Complete recipe: add a NEW client-plugin package to the web-app bundle

Source of truth: packages/client/AGENTS.md:134-144 ("New plugin package checklist — ui-workspace is a complete example; ui-sidebar/ui-user-questions are minimal skeletons") and ui-workspace's actual files.

All of this is *inside the monorepo*. (For a plugin living outside the repo, see §7.)

### 3.1 Files to create (mirror ui-workspace)

Under `packages/client/<name>/`:

1. **`package.json`** — fields copied from ui-workspace/package.json:1-88:
   - `name: "@deepseek-ai/dsh-client-<name>"`, `exports` with `.`, `./invariant`, `./client` (→ `./lib/client.js`), `./src/*`, `./package.json`.
   - `"dsh": { "client": { "inject": [<every dsh.client neighbor your package imports type-or-value…] , "platform": "web" } }` — `platform: "web"` mandatory (AGENTS.md:140).
   - `"files": ["lib/index.js","lib/invariant.js","lib/client.js","lib/types/**/*.d.ts"]`.
   - `peerDependencies`: `@deepseek-ai/cordis`. `devDependencies`: every workspace value/type the client half touches (`ui-slots`, `ui-renderer`, `ui-session`, `ui-conversation`, `store`, `locale`, `ui-primitives`, `@types/react`, `react`, `dsh-invariants`, …); ordinary npm libs (`clsx`) in `dependencies` (AGENTS.md:57-67).
2. **`tsconfig.json`** — extends `tsconfig.base.client.json`, `rootDir: src`, `outDir: lib/types`, one `references` entry per workspace dependency plus `runtime-diagnostics/invariants`, and registered in the `tsconfig.client.json` aggregate (AGENTS.md:138-139; packages/AGENTS.md:23).
3. **`tsdown.config.ts`** — `import { clientBundle } from '../tsdown.client.ts'; export default clientBundle('@deepseek-ai/dsh-client-<name>', ['lib/types/index.js','lib/types/invariant.js'])`.
4. **`src/index.ts`** — empty node-half `export function apply(): void {}` (ui-workspace/src/index.ts:9).
5. **`src/invariant.ts`** — manifest registration (packages/AGENTS.md:19).
6. **`src/client/index.ts`** — the browser half: `inject` service names, `apply(ctx)` calling `ctx.slots.inject(name, () => ctx.slots.register(...))`, locale dictionaries, optional `ctx.slots.provideRoot({hooks})` / `ctx.uiSession.provide({hooks})` for global/session standard hooks (ui-workspace/src/client/index.ts:62-159).
7. **`src/css-modules.d.ts`** when using CSS Modules; **README.md** with a Model Experience section.
8. Optional `src/client/contract/slots.ts` to type your registrations and declare your *child* slots into `SlotMap` (ui-workspace/src/client/contract/slots.ts:60-69), and `src/client/stores.ts` exporting `createXXXStore()` factories.

### 3.2 The three registration surfaces (all required)

From AGENTS.md:139-140 — missing any one "fails at a different, later point":

1. `tsconfig.client.json` aggregate `references` entry.
2. **`packages/bundle/web-app/cordis.patch.yml`** — add a browser roster row in the big `- insert:` list (cordis.patch.yml:43-307):
   ```yaml
   - id: ui-<name>
     name: '@deepseek-ai/dsh-client-<name>'
   ```
   (Disabled rows use `disabled: true`, e.g. ui-schedule at cordis.patch.yml:264-266.)
3. **`packages/bundle/web-app/package.json`** — add `"@deepseek-ai/dsh-client-<name>": "workspace:^"` under `dependencies` (web-app package.json:46-119). "Profile boots resolve bare row names through the healed `$DSH_HOME/profiles/node_modules` fallback… a row whose package no manifest declares fails to import" (AGENTS.md:139).

`pnpm-workspace.yaml` already globs `packages/*/*` (root package.json:11-18), so no workspace-list change is needed for `packages/client/<name>`.

### 3.3 The apply body you write

Typical shape (quoted from ui-workspace src/client/index.ts:72-159, lightly trimmed):

```ts
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'remote'] // services your closures read

export function apply(ctx: Context): void {
  ctx.slots.provideRoot({ hooks: { workspaces: ctx.get('workspaces').list } }) // global hooks
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '…: dictionaries')
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },
      store: createWorkspaceViewStore(),   // shared view state only
      inject: () => ({ …callbacks…, hooks: { …bare observables… } }),
      locale: NS,
    },
    WorkspaceBrowser,
  ))
}
```

Minimal alternative (ui-user-questions src/client/index.ts:94-106) — a chain slot + Remote-event subscription:

```ts
ctx.slots.inject('conversation.composer', () => ctx.slots.register(
  { name: 'conversation.composer',
    select: ({ pendingInteraction }) => pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,
    locale: NS, store: questionDraftStore }, QuestionComposer))
ctx.remote.$on('user-questions/request', function (request, next) { … })
```

### 3.4 Build steps and how to run/test

1. Type/lint inner loop: `pnpm run test:gui` (runs the `packages/client` + `packages/host` vitest suites; root package.json:55).
2. Build your bundle: `pnpm --filter @deepseek-ai/dsh-client-<name> bundle` (the per-package `bundle` script, ui-workspace package.json:49) — "the registry serves `lib/client.js`, not sources" (AGENTS.md:142).
3. Build the shell/static side after shell-affecting changes: `pnpm run build` (tsx scripts/build.ts) or incrementally `pnpm run build:web` (vite) — note `pnpm run dev:web` (tsx scripts/dev-web.ts --poll) is the *watcher* for the live loop: it keeps tsc `lib/types`, tsdown `lib/*.js`, and `apps/web/dist` rebuilt on source change; the running `dsh web` Host stat-polls bundle mtimes and broadcasts `rebuilt` rev frames over the `/plugins/events` SSE channel, so the browser hot-swaps without a manual refresh (packages/client/hmr/src/index.ts:158-200; scripts/dev-web.ts:1-29).
4. Run the GUI: `pnpm dsh web` (from source) or `dsh web`; serves `http://127.0.0.1:3080`.
5. Before pushing: `DSH_SNAPSHOT=replay pnpm run test:web` (rebuilds dist then runs the browser smoke + keyless replayed e2e), and `pnpm run test:gui` for the inner loop (packages/client/AGENTS.md:124-133).
6. For new conversations/tool views also add per-package spec files under `tests/` (component specs get `// @vitest-environment jsdom`).

---

## 4. Data paths: how client components get live data

Architecture layers (docs/subsystems/web-client.md:7-18): Host state → remote transport → Client model (React-free) → UI adapter → Conversation/presentation → Slots → React. "A presentation component never receives Cordis `ctx`, a transport object, or another feature plugin's implementation" (:18).

### 4.1 Model services and hooks

- **Sessions** — `api/session-controller` Client face: `ClientSessions → SessionManager → Session`; on the client context it is the `ctx.sessions` service (`ISessions`) (:40-46). `ui-session` turns it into standard props: `useSessions` (selector over `SessionListState`), per-session `sessionId`, `useSession` (over `SessionSnapshot`), `useProjection`, plus `useSessionPendingInteraction`; it installs the session scope adapter (`ctx.slots.installScope('session', service.adapter)`) and provides the root hooks via `ctx.slots.provideRoot({hooks:{sessions: ctx.sessions.list,…}})` (packages/client/ui-session/src/client/index.ts:104-129, 505-514). Domain adapters add further hooks through `ctx.uiSession.provide({hooks, resolve})` — e.g. ui-chat publishes `useChat`, ui-trajectory publishes `useTrajectory` (ui-chat/src/client/apply.ts:74-77).
- **Workspaces** — `api/workspace-controller` Client face is `ctx.workspaces` (`IWorkspaces`); ui-workspace contributes the global `useWorkspaces` hook via `provideRoot` (ui-workspace/src/client/index.ts:77; ui-workspace/src/client/navigation.ts).
- **Conversation** — `ui-conversation` owns per-session event/view registries, one binding per `SessionBinding` (conversation.md:5). `ctx.uiConversation.binding(sessionId).target('chat'|'trajectory'|…)` exposes the assembled target snapshot; view packages wrap it into an `ObservableSnapshot` and publish it as a hook (ui-trajectory/src/client/index.ts:48-76).
- **Stores** — snapshot-store engine in `client/store` (`defineStore`, `createSnapshotStore`, `shallowEqual`; packages/client/AGENTS.md:46). Slot stores hold only shared viewing/interaction state; business state never lives in a store (AGENTS.md:52). Component gets `useStore`/`actions` from the registration's declared `store`.
- **Registration-private live facts** — reserved `hooks` compartment of the inject face: bare `{getSnapshot, subscribe}` sources the renderer binds into `use<Name>` hooks (slots.md:100-103). Example: ui-workspace publishes a `HostObservable<boolean>` for slot occupancy and `RemoteHostFacts` for host info (ui-workspace/src/client/index.ts:88-97).

### 4.2 Transport used by the client to reach the Host

From `packages/client/connection/README.md` and `packages/api/gateway`:

- **Unary RPC: HTTP POST to `/api`** with JSON bodies; the Host owns the single `/api` route + Fetch bridge + browser authentication (README.md:28, 33-39). `API_PATH = '/api'` (packages/client/connection/src/api-path.ts:7).
- **Logical streams: one WebSocket mux `/api/remote.mux`** owned by API Gateway (`REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`, packages/api/gateway/src/stream-protocol.ts:6; upgrade registered at packages/api/gateway/src/index.ts:223 with a `noServer` WebSocketServer, stream-server.ts:26). Every controller *Remote stream* (session `follow()`, control, workspace follow) rides this mux; "Gateway mux restores the physical WebSocket; each RemoteStream reopens its own logical source when the Connection publishes a usable generation" (web-client.md:74-80).
- **Forwarded events: the `$events` logical stream** — API remotes registers an allowlist of Host Cordis events (mode emit or waterfall) and feeds them to the Gateway as a `TypertRemoteEventSource` (packages/api/remotes/src/index.ts:37-78). Its opening `ready` frame carries `{type:'ready', clientId, host:{home}}` and establishes the Connection generation (connection/README.md:42-46). `ctx.remote.$on(event, listener)` on the client receives allowlisted events (ui-user-questions/src/client/index.ts:104-106 shows a waterfall round-trip answering `user-questions/request`).
- **Dev reload: SSE `/plugins/events`** (`EVENTS_ENDPOINT = '/plugins/events'`, packages/client/hmr/src/events.ts:44; browser side uses `new EventSource(EVENTS_ENDPOINT)`, hmr/src/client/index.ts:166).
- Generated Remote namespaces are mounted client-side by api-remotes' client half via `ctx.remote.$mount(contribution)` (packages/api/remotes/src/client/index.ts:141-157). Host methods are declared with Typert Remote decorators and become `ctx.remote.<namespace>` (web-client.md:28).

Reconnect semantics: physical/logical recovery separate; durable session windows atomically replace from generation baselines; ordinary forwarded notifications are not replayed (web-client.md:74-82). There is no universal `resync()`.

### 4.3 What a client can observe about sessions (quick reads)

- `session-query` (docs/subsystems/session-query.md): Host-side exact-read vocabulary (`SessionRecord`, `SessionLogSnapshot`, `SessionSurfaceSnapshot`, title observations) — reachable from the client only through generated Remotes (e.g. `sessionReferenceResolver/candidates`, session-reference.md:59).
- `session-projection` (docs/subsystems/session-projection.md:5-11, 44-58): Host folds `session/event` through registered `ProjectionDefinition`s and ships whole current values to clients via the session controller's history tail page and `session/projection` push frame. `useProjection` reads these finished values keyed by projection key.
- `session-reference` (docs/subsystems/session-reference.md): cross-session mention/reference machinery and file candidates — host-backed, surfaced to the browser by Remote methods.

Rule of thumb for a visual layer: durable, live, replayable per-session UI data flows into React *only* through those standard hooks or the registration's own hooks compartment; you never open a second history stream.

---

## 5. External-service reach (the crux for Archon)

### 5.1 Can a client plugin call an external HTTP/SSE server directly from the browser?

Yes, mechanically — a client plugin's browser half is ordinary JavaScript running on the DSH origin, and **there is no Content-Security-Policy** anywhere in the shipped tree (`apps/web/index.html` has none; grep for `Content-Security-Policy` across `packages/` returns nothing). Constraints that do apply:

1. **Same-origin policy / CORS.** The page is served from `http://127.0.0.1:3080` (loopback). A `fetch`/`EventSource`/WebSocket to Archon's own loopback origin (`http://127.0.0.1:<archon-port>`) is **cross-origin**; the target must answer CORS (notably `Access-Control-Allow-Origin`) for `fetch`/`EventSource`, and WebSocket handshakes are governed by the server's Origin check. DSH sends **no CORS headers at all** (grep for `Access-Control-Allow`/`access-control-allow`/`cors(` across `packages/` returns zero matches), so DSH is never the enabler for an inbound third party — the external server must be CORS-open. Plain cross-origin `fetch` of a *public* URL with no credentials works under permissive CORS; `EventSource` is a CORS-simple GET.
2. **The browser-trust fence only guards `/api`.** Host/Origin checks and browser-session auth apply to requests DSH serves on `/api` (`api-request-trust.ts`; connection/README.md:39). They do not govern the page's own outbound fetches to other origins — those are ordinary browser requests.
3. **Model-visible means logged.** If Archon-derived text is injected into the DSH model's context, it must be reconstructable from the session log (repo-wide invariant; docs/architecture.md:107). Pure *display* in a visual layer is not model-visible and needs no session event.
4. **Presentation-only & data channels** (packages/client/AGENTS.md:52-55): live Archon state used only for rendering must arrive through the sanctioned channels — registration `hooks` compartment (`HostObservable`) for plugin-private live facts, declared stores for shared view state, or owner props. You may not stuff external business state into `ctx.sessions`/model stores or mirror it in components directly.

### 5.2 Host-side options that CAN relay Archon's HTTP/SSE into the GUI without CORS

Because the browser and Host share one loopback origin, a **same-origin relay on the Host** removes every CORS problem. The Host is a full Cordis plugin tree; a plugin in the profile can do outbound HTTP itself (Node), expose it under DSH's own origin, and the client plugin just fetches same-origin paths:

1. **Host route relay (recommended, simplest).** Any host plugin can call `ctx.webServer.register({kind:'prefix', path:'/archon', handler})` or `registerUpgrade({path, handler})` (packages/host/webserver/src/index.ts:180; docs/subsystems/web-server.md:11-27). Named exact/prefix routes win over the SPA fallback (frontend-static), so `/archon/*` is never swallowed by index-serving. The handler performs the outbound HTTP call to Archon server-side (no browser CORS) and can hold the response open for SSE — `registerUpgrade` gives a WebSocket/SSE upgrade slot (the API Gateway uses exactly this to host `/api/remote.mux`; api/gateway/src/index.ts:223). Caveat: route registration is a composition-level contract (duplicate `(kind,path)` throws, web-server.md:51) and the relay must own its own outbound auth.
2. **A "full-stack" client-plugin package with a real node half.** The node half of a `packages/client/*` package *is* a Host plugin (it is loaded by the Host Loader). Convention keeps it empty for pure UI, but nothing structural prevents it from registering such a webServer route (then the browser half fetches same-origin). Keep the package's dependency declarations honest (`verify-package-dependencies`). If the relay must run outside the DSH process (e.g. Archon ships its own server), option 1 in a separate host bundle is cleaner.
3. **New Remote methods/streams on a host controller** (Typert Remote decorators + generated codecs) — e.g. adding `ArchonController` methods exposed as `ctx.remote.archon.*` and Remote *streams* carried over the `/api/remote.mux` WebSocket. This is the "native" DSH shape for a host-service-backed feature (session-controller is the reference), but it is heavier than a route relay because it requires the Typert generation pipeline.
4. **Feature-owned exact Fetch routes under `/api`** — Connection exposes exact `GET`/`HEAD` route registration for feature downloads (connection/rpc.ts:146-171, `createSharedFetchHandler`); those are host-served same-origin endpoints, suitable for file/blob downloads, not arbitrary proxying.
5. **Web capability / webhook (model- or host-driven, not a general GUI pipe).** `ctx.web` search/fetch is a model-facing capability seam with its own HTTP fetch provider (docs/subsystems/web.md; the local provider enforces public-address-only, web.md:127-131) — usable by the *agent*, not as a browser data pipe. `ctx.webhookRuntime` ingress is for creating/forwarding to Host Sessions from outside events (docs/architecture.md:132, webhook.md). Neither is the right carrier for a live visual layer, but a webhook or a model tool could be the trigger that starts/steers Archon work.

### 5.3 Existing plugins proxying an external service into the GUI

None was found in the monorepo: no plugin registers a generic outbound HTTP relay to a third-party server, and grep finds no CORS middleware or proxy package. The closest external-UI precedent is **turtle-ui** (`github.com/deepseek-harness/turtle-ui`), an *out-of-tree* client plugin example referenced by the docs (docs/user/develop/basic/publish.md:163; apps/cli/reference/README.md:60-64) — it demonstrates the packaging story (§7), not a proxy. So the Archon relay is greenfield: either direct cross-origin browser calls to a CORS-open Archon server, or (cleaner) a small same-origin Host relay.

---

## 6. Build / dev / verification workflow summary

Commands are from the repo root `E:\deepseek-harness` (`package.json` scripts):

| Goal | Command | Notes |
|---|---|---|
| GUI inner test loop | `pnpm run test:gui` | vitest over `packages/client packages/host`; seconds, no browser (package.json:55; client/AGENTS.md:124-133). |
| Browser e2e/snapshot | `DSH_SNAPSHOT=replay pnpm run test:web` | runs `npm run build` then the built web suite (`vitest.web.config.ts`); keyless replay mode; `DSH_SNAPSHOT=refresh` after intentional output changes (package.json:46-52). |
| Client bundle (one package) | `pnpm --filter @deepseek-ai/dsh-client-<name> bundle` | emits `lib/client.js`, served by the registry (AGENTS.md:142). |
| Watched dev loop | `pnpm run dev:web` (scripts/dev-web.ts --poll) | keeps `lib/types`, `lib/*.js`, `apps/web/dist` rebuilt; MUST NOT run concurrently with `pnpm run build` (dev-web.ts:16-17). Running `dsh web` + this watcher gives HMR: bundle mtimes are polled and revs broadcast over `/plugins/events`, browser reloads automatically; otherwise a plain page refresh picks up the new bundle. |
| Run the GUI | `pnpm dsh web` (source) / `dsh web` | `http://127.0.0.1:3080`; dist changes need a restart; client bundle changes need only the rebuild (+ optional refresh/HMR). |
| Live slot-tree inspection | `cordis_inspect what:"client"` | query occupants/declarations of a running client (slots.md:165). |
| Other gates | `pnpm run typecheck`, `lint`, `verify-client-packages`, `verify-package-dependencies`, `gen-client-catalog` | repo hygiene (package.json:28-33, 109-127). |

The URL `http://127.0.0.1:3080` reflects the *served index* on every load: "The injection rows carry the current graph on every index render, so a reload always boots against the live composition" (client-modules.md:85). New plugin *rows* require the server to have re-scanned (restart or hot patch reload of the profile — the shipped `web` profile is live for patch layers; architecture.md:29, apps/cli/reference/README.md:84).

---

## 7. Hard rules constraining a "visual layer for an external engine" plugin

1. **Presentation-only web layer.** "Nothing that is only 'how to draw' enters the session log. … A new *model-visible* input still requires a session event (repo-wide rule)." (packages/client/AGENTS.md:55). If Archon status is only drawn, it never touches `SessionEvent`; if it must be chat-replayable, emit durable events from a *host* contributor and register a `ConversationNodeDefinition` + keyed renderer (docs/subsystems/conversation.md:29-45; architecture.md:138-139).
2. **No business data in slot stores.** Entry-declared stores carry shared *viewing/interaction* state only (selection, drafts, panel widths); sessions/frames/connections stay in the object layer (AGENTS.md:52). Archon's engine state must live in a plugin-owned model/service, projected to the UI via the `hooks` compartment or standard-hook machinery.
3. **No model-visible input without a session event.** (architecture.md:107.) A visual layer that lets the user steer Archon, and expects DSH's model/agent to see it, must log it; steering Archon *outside* the model (direct user gesture → Archon API) is fine without it.
4. **Component/ctx discipline.** Components receive the four derived props shares only, never `ctx`; live data has exactly three channels (owner props / local state / declared store), derived data is pure `useMemo` (AGENTS.md:13-16, 38-40). A plugin may not hand-make hooks or add a global standard prop for entry-private data.
5. **Dependency declaration.** Client/browser + type relations are devDependencies; ordinary npm libs are dependencies; host value imports must be classified (AGENTS.md:57-67). No runtime-import or re-export of another feature plugin's values; cross-plugin behavior = services, cross-plugin UI = slots; `dsh.client.external` is NOT a feature-plugin dependency mechanism (AGENTS.md:36, 76-79). UI copy goes through typed locale dictionaries + the `t` seat (AGENTS.md:111-113).
6. **One plugin package per UI feature**, `src/client/` browser half, registration only inside `apply` (no module-level side effects) (AGENTS.md:105-107).
7. **Presentation/purity gates.** The dynamic build preset externalizes the baseline and rejects undeclared workspace value imports (`verify-client-packages`); INLINE_SAFE whitelists which value-only packages may be inlined into a client bundle (packages/client/tsdown.client.ts:61-72). CSS Modules + `--dsw-*` tokens, no Tailwind/component library (client/AGENTS.md:109-111).

### 7.1 Can a plugin live OUTSIDE `E:\deepseek-harness` and be loaded?

Yes — and the docs treat it as a first-class path, because everything a plugin needs (Loader rows, bundles, the web roster) is declared in package.json, not hardcoded:

- **Host/bundle form (any package).** A profile under `$DSH_HOME/profiles/<name>` lists bundles in `dsh.profile.bundles`; an npm/git package declaring `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` is installed with `dsh plugin --profile <name> add <pkg|git|./checkout>`, and its patch inserts plugin rows (docs/user/develop/basic/publish.md:9-111; apps/cli/reference/README.md:44-66). Bundle membership changes need a profile restart; profile/home `cordis.patch.yml` edits hot-reload on the shipped `web` profile.
- **Client-plugin (browser-half) form.** The web roster scan is not repo-bound: `dsh.client.modules` scans the *Host Loader's entries* — whatever package the composition mounts as a Loader row whose manifest carries `dsh.client` and a `./client` export — and each row resolves "from its own Loader specifier and owning-tree `baseUrl`" (docs/subsystems/client-modules.md:77-78). So an out-of-tree package can contribute browser UI if (a) it is a plugin row of a patch layer (via a bundle you ship), (b) its manifest declares `dsh.client` (`platform: 'web'`) with `exports["./client"]`, and (c) it ships a **built** `lib/client.js` produced by an equivalent of the monorepo's tsdown client preset. **turtle-ui is the documented working example** of exactly this, including the `prepare`-script catch for git installs (publish.md:161-176; cli reference README.md:60-66).
- **Runtime module fallback.** Profile boots resolve bare row names through the healed `$DSH_HOME/profiles/node_modules` fallback, which mirrors declared dependencies (AGENTS.md:139). The web UI's own package bundle (`dsh-web-app`) lists each shipped client package as a dependency so rows resolve (web-app package.json:46-119).
- **Two practical consequences for Archon:**
  1. If Archon UI must be developed/iterated inside the DSH tree, follow §3 (monorepo package). 
  2. If Archon UI must ship as a standalone, out-of-tree surface, ship a bundle whose `cordis.patch.yml` inserts (i) a host relay row (webServer route/upgrade, or a full-stack package row) and (ii) the client plugin row naming your package (with `dsh.client` + `./client` export + built bundle), plus any `--patch` overlay for Archon's base URL config. It then behaves like ui-cordis, which itself lives *outside* `packages/client/` (at `packages/extensions/ui-cordis`, added to web-app dependencies and the roster at cordis.patch.yml:227-228) — proving the roster tolerates non-`packages/client` homes.

---

## 8. Key file:line evidence index

- Boot kernel & graph global: `packages/client/web/src/boot.ts:46-101,113-158`; `packages/client/web/src/seed.ts:23-37`; `packages/client/web/src/platform.ts:8-17`.
- WebBootGraph wire types: `docs/subsystems/client-modules.md:22-71`; bundle/combo route & 404 semantics: `client-modules.md:83-85`; registry service `ctx.clientModules`: `packages/client/modules/src/index.ts` (`/plugins/??…` at :256, :308, :357), node half `src/index.ts`.
- Slot registry API & validation: `packages/client/ui-slots/src/index.ts:26,89-124,440-448,664-702,705-894`; service `'slots'`: `packages/client/ui-renderer/src/client/registry.ts:134`; `'root'` SlotMap: registry.ts:27-45.
- Top-level layout slots: `packages/client/ui-layout/src/client/index.ts:36-88,119-147`.
- Conversation slots: `packages/client/ui-conversation/src/client/contract/slots.ts:93-147`; declarations: apply.ts:201-212, 243-281; view registry: `ui-conversation/src/client/conversation/view-registry.ts:12-19`.
- Chat/tool slots: `packages/client/ui-chat/src/client/contract/slots.ts:156-212`; chat apply incl. `conversation.view` `id:'chat'` and `conversation.chat.node` child with `CHAT_NODE_INJECT`: apply.ts:35-46, 98-167. Tool views: `packages/client/ui-tool/src/client/contract/slots.ts:10-27`, apply.ts:33-56.
- Client-package skeleton: `packages/client/ui-workspace/package.json:16-88`, `src/index.ts:1-9`, `src/client/index.ts:62-159`, `src/client/contract/slots.ts:60-69`, `tsdown.config.ts:1-3`; minimal: `packages/client/ui-user-questions/src/client/index.ts:88-106`; full checklist: `packages/client/AGENTS.md:134-144`.
- Web-app bundle: `packages/bundle/web-app/cordis.patch.yml:43-307` (roster rows), `:264-266` (disabled), `package.json:46-119` (deps); `packages/extensions/ui-cordis` non-`packages/client` example.
- Transport: `packages/client/connection/README.md:28,33-46`; `/api`: `packages/client/connection/src/api-path.ts:7`; WebSocket mux: `packages/api/gateway/src/stream-protocol.ts:6`, index.ts:223; forwarded events: `packages/api/remotes/src/index.ts:37-78`; HMR SSE: `packages/client/hmr/src/events.ts:44`, hmr/src/index.ts:158-200.
- Data hooks: `packages/client/ui-session/src/client/index.ts:104-129,505-514`; `ui-chat/src/client/apply.ts:74-77`; `ui-trajectory/src/client/index.ts:47-107`; adapter/provider machinery: slots.md:73-104.
- No CORS / no CSP: grep `Access-Control-Allow|access-control-allow|cors(` and `Content-Security-Policy` over `packages/**` → 0 matches; `apps/web/index.html` has no CSP.
- webServer route contract & fallback: `packages/host/webserver/src/index.ts` (registerUpgrade :180), `docs/subsystems/web-server.md:11-27,51`.
- Out-of-tree: `docs/user/develop/basic/publish.md:9-128,161-176`; `apps/cli/reference/README.md:44-66,80`; client-modules scan scope: `docs/subsystems/client-modules.md:75-81`.
- Presentation-only + model-visible rule: `packages/client/AGENTS.md:52-55`; `docs/architecture.md:103-109`.

---

## Summary (most important findings)

1. The DSH GUI is a **browser-side Cordis app**: a Vite-built shell (`apps/web` → `@deepseek-ai/dsh-client-web`, boot kernel `src/boot.ts`) plus independently bundled **client plugins** discovered from Host Loader entries whose package.json declares `dsh.client` (`platform:'web'`) and exports `./client` → `lib/client.js`, served by the Host at `/plugins/??<pkg>/client.js&rev=…` (docs/subsystems/client-modules.md).
2. All UI composition is through **one slot API** — `ctx.slots.inject(key, () => ctx.slots.register({name, children?, store?, inject?, locale?, …}, Component))` over the compile-time `SlotMap`; `children` declares AND authorizes child slots; `root` is the only shell-rendered slot (ui-slots/src/index.ts, ui-layout/src/client/index.ts).
3. **Existing attach points**: whole-column replacements `sidebar`/`conversation`/`details` (single), additive `shell.overlay` (list), per-view tabs `conversation.view` (list — chat/trajectory are entries), chat nodes `conversation.chat.node` (keyed), tool views `tool.call.toolview` (keyed by tool name), and many list seats in sidebar/settings/composer.
4. Data reaches React only via standard hooks (`useSessions/useSession/useWorkspaces/useProjection/useChat/useTrajectory/useStore`), registration `hooks` compartments, and owner props — components never see `ctx`, stores never hold business state.
5. Transport is loopback-only: unary HTTP POST `/api`, logical streams over the WebSocket mux `/api/remote.mux`, allowlisted forwarded events via `$events` (`ctx.remote.$on`), dev HMR SSE `/plugins/events`. There is **no CSP** and **no CORS middleware**, so a client plugin *may* call an external HTTP/SSE server directly if that server sends CORS headers; a same-origin Host relay via `ctx.webServer.register/registerUpgrade` (or new Remote streams) removes CORS entirely.
6. New monorepo client plugin = new `packages/client/<name>` package (ui-workspace is the template) + **three surfaces**: tsconfig.client.json reference, a roster row in `packages/bundle/web-app/cordis.patch.yml`, and a `dsh-web-app` dependency; rebuild with `pnpm --filter <pkg> bundle`; run/test with `pnpm dsh web` (`http://127.0.0.1:3080`), `pnpm run dev:web` watcher for HMR, `pnpm run test:gui`, `DSH_SNAPSHOT=replay pnpm run test:web`.
7. Plugins **can live outside the monorepo**: a bundle declaring `dsh.bundle` + patch rows is installed via `dsh plugin --profile <name> add`, and any Loader row whose package carries `dsh.client` + a built `./client` gets browser UI (turtle-ui is the documented external example; ui-cordis itself lives outside `packages/client/`).
8. Hard rules: web layer is presentation-only, model-visible input must be a durable session event, no runtime imports of other feature plugins, no business data in stores, all copy localized.
9. No existing plugin proxies an external service into the GUI — an Archon relay is greenfield; the cleanest shape is a host row registering a `/archon` prefix route/upgrade (host-side outbound, same-origin to the browser) plus a client plugin rendering it through slots, with direct browser→Archon calls as the CORS-dependent fallback.
