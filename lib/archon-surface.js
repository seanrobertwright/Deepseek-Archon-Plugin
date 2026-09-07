/**
 * dsh-archon — the Archon API surface this plugin depends on.
 *
 * The single place that knows Archon's REST paths, SSE frame names, and the
 * field names of its response rows. Everything else in the plugin works on
 * the normalized objects produced here, so an Archon release that renames a
 * path or a column is absorbed by editing this file and re-recording the
 * contract snapshot (`node tests/contract-check.mjs --update`).
 *
 * Two consumers:
 *   - the host half imports it as an ES module (archon-client.js, tools.js,
 *     tests/contract-check.mjs);
 *   - the browser bundle cannot import host files, so `lib/client.js` embeds a
 *     verbatim copy between `// >>> archon-surface` and `// <<< archon-surface`
 *     markers with the `export ` keywords stripped. `node scripts/sync-client-surface.mjs`
 *     refreshes the copy and `tests/surface-mirror.mjs` fails when it drifts.
 *
 * Keep this file to plain ES5-style functions and `var` so the embedded copy
 * runs unchanged inside the browser factory.
 *
 * @module dsh-archon/archon-surface
 */

/** URL-encode one path segment. */
function enc(value) {
  return encodeURIComponent(String(value));
}

function firstLine(text) {
  return String(text || "").split("\n")[0] || "";
}

/**
 * Paths relative to Archon's `/api` root. The host prefixes them with
 * `<base>/api`; the browser prefixes them with `/archon/api` (the relay).
 */
export var ARCHON_PATHS = {
  health: function () { return "/health"; },
  openapi: function () { return "/openapi.json"; },
  codebases: function () { return "/codebases"; },
  codebase: function (id) { return "/codebases/" + enc(id); },
  codebaseEnv: function (id) { return "/codebases/" + enc(id) + "/env"; },
  codebaseEnvKey: function (id, key) { return "/codebases/" + enc(id) + "/env/" + enc(key); },
  workflows: function (cwd) { return "/workflows" + (cwd ? "?cwd=" + enc(cwd) : ""); },
  /** One workflow definition: GET reads it, PUT writes it, DELETE removes it. */
  workflow: function (name, cwd, source) {
    var query = [];
    if (cwd) query.push("cwd=" + enc(cwd));
    if (source) query.push("source=" + enc(source));
    return "/workflows/" + enc(name) + (query.length ? "?" + query.join("&") : "");
  },
  workflowValidate: function () { return "/workflows/validate"; },
  commands: function (cwd) { return "/commands" + (cwd ? "?cwd=" + enc(cwd) : ""); },
  workflowRun: function (name) { return "/workflows/" + enc(name) + "/run"; },
  runs: function (options) {
    var query = [];
    if (options && options.status) query.push("status=" + enc(options.status));
    if (options && options.limit) query.push("limit=" + enc(options.limit));
    return "/workflows/runs" + (query.length ? "?" + query.join("&") : "");
  },
  run: function (id) { return "/workflows/runs/" + enc(id); },
  runControl: function (id, verb) { return "/workflows/runs/" + enc(id) + "/" + verb; },
  runArtifacts: function (id) { return "/runs/" + enc(id) + "/artifacts"; },
  /** Wildcard content route: path segments are escaped, the separators are not. */
  artifact: function (id, path) {
    return "/artifacts/" + enc(id) + "/" + String(path).split("/").map(enc).join("/");
  },
  conversations: function () { return "/conversations"; },
  conversationMessages: function (id, limit) {
    return "/conversations/" + enc(id) + "/messages" + (limit ? "?limit=" + enc(limit) : "");
  },
  conversationMessage: function (id) { return "/conversations/" + enc(id) + "/message"; },
  conversationStream: function (id) { return "/stream/" + enc(id); },
  dashboardStream: function () { return "/stream/__dashboard__"; },
  config: function () { return "/config"; },
  configAssistants: function () { return "/config/assistants"; },
  providers: function () { return "/providers"; },
};

/** Run control verbs Archon accepts on `/workflows/runs/{id}/{verb}`. */
export var RUN_CONTROL_VERBS = ["approve", "reject", "resume", "cancel", "abandon"];

/** SSE event names the plugin listens for on each stream. */
export var SSE_EVENTS = {
  dashboard: ["workflow_status", "dag_node"],
  conversation: ["text", "tool_call", "tool_result", "conversation_lock", "workflow_status"],
};

/**
 * Endpoints the plugin calls, as OpenAPI path templates. `tests/contract-check.mjs`
 * snapshots exactly these operations from Archon's `/api/openapi.json`; the
 * two streams and the artifact content route are not described by the spec.
 */
export var ENDPOINTS = [
  { method: "get", path: "/api/health", use: "server state, version" },
  { method: "get", path: "/api/codebases", use: "projects" },
  { method: "post", path: "/api/codebases", use: "register project" },
  { method: "delete", path: "/api/codebases/{id}", use: "remove project" },
  { method: "get", path: "/api/codebases/{id}/env", use: "project env keys" },
  { method: "put", path: "/api/codebases/{id}/env", use: "set project env var" },
  { method: "delete", path: "/api/codebases/{id}/env/{key}", use: "delete project env var" },
  { method: "get", path: "/api/workflows", use: "discoverable workflows" },
  { method: "get", path: "/api/workflows/{name}", use: "one workflow definition" },
  { method: "put", path: "/api/workflows/{name}", use: "write a workflow definition" },
  { method: "delete", path: "/api/workflows/{name}", use: "delete a workflow definition" },
  { method: "post", path: "/api/workflows/validate", use: "validate a workflow definition" },
  // Pinned against the live spec, but not yet called by any surface: the Studio
  // reserves GET /api/commands for command autocomplete. The row stays so the
  // contract test keeps watching the endpoint's shape across Archon releases.
  { method: "get", path: "/api/commands", use: "discoverable commands" },
  { method: "post", path: "/api/workflows/{name}/run", use: "launch a run" },
  { method: "get", path: "/api/workflows/runs", use: "recent runs" },
  { method: "get", path: "/api/workflows/runs/{runId}", use: "run detail + events" },
  { method: "post", path: "/api/workflows/runs/{runId}/approve", use: "run control" },
  { method: "post", path: "/api/workflows/runs/{runId}/reject", use: "run control" },
  { method: "post", path: "/api/workflows/runs/{runId}/resume", use: "run control" },
  { method: "post", path: "/api/workflows/runs/{runId}/cancel", use: "run control" },
  { method: "post", path: "/api/workflows/runs/{runId}/abandon", use: "run control" },
  { method: "get", path: "/api/runs/{runId}/artifacts", use: "run artifacts" },
  { method: "get", path: "/api/conversations", use: "web conversations" },
  { method: "post", path: "/api/conversations", use: "create web conversation" },
  { method: "get", path: "/api/conversations/{id}/messages", use: "chat history" },
  { method: "post", path: "/api/conversations/{id}/message", use: "send chat message" },
  { method: "get", path: "/api/config", use: "engine settings" },
  { method: "patch", path: "/api/config/assistants", use: "save assistant settings" },
  { method: "get", path: "/api/providers", use: "AI providers" },
];

// ---- response normalizers ---------------------------------------------------
// Each takes one raw Archon row and returns the plugin's own view model.
// Only these functions read Archon field names.

/** `GET /health` body -> { status, version, adapter, activePlatforms, runningWorkflows, concurrency, database }. */
export function normalizeHealth(raw) {
  var h = raw && typeof raw === "object" ? raw : {};
  var c = h.concurrency && typeof h.concurrency === "object" ? h.concurrency : {};
  return {
    status: typeof h.status === "string" ? h.status : "unknown",
    version: typeof h.version === "string" ? h.version : "",
    adapter: typeof h.adapter === "string" ? h.adapter : "",
    activePlatforms: Array.isArray(h.activePlatforms) ? h.activePlatforms : [],
    runningWorkflows: typeof h.runningWorkflows === "number" ? h.runningWorkflows : null,
    concurrency: {
      active: typeof c.active === "number" ? c.active : null,
      maxConcurrent: typeof c.maxConcurrent === "number" ? c.maxConcurrent : null,
    },
  };
}

/** One row of `GET /codebases` -> { id, name, repositoryUrl, defaultCwd, kind }. */
export function normalizeCodebase(raw) {
  var c = raw && typeof raw === "object" ? raw : {};
  return {
    id: c.id,
    name: c.name || c.id || "",
    repositoryUrl: c.repository_url || "",
    defaultCwd: c.default_cwd || "",
    kind: c.kind || "",
  };
}

/** Match a registered project by path, URL, or name (the `codebase` tool argument). */
export function codebaseMatches(codebase, needle) {
  return codebase.defaultCwd === needle || codebase.repositoryUrl === needle || codebase.name === needle;
}

/** One entry of `GET /workflows` -> { name, source, description }. */
export function normalizeWorkflowEntry(raw) {
  var entry = raw && typeof raw === "object" ? raw : {};
  var w = entry.workflow && typeof entry.workflow === "object" ? entry.workflow : entry;
  return {
    name: w.name || "?",
    source: entry.source || "?",
    description: firstLine(w.description),
  };
}

/** `GET /workflows` body -> { entries, errorCount }. */
export function normalizeWorkflowList(raw) {
  var list = raw && Array.isArray(raw.workflows) ? raw.workflows : [];
  return {
    entries: list.map(normalizeWorkflowEntry),
    errorCount: raw && Array.isArray(raw.errors) ? raw.errors.length : 0,
  };
}

/**
 * `GET /workflows/{name}` body -> { workflow, filename, source }. `workflow` is
 * the definition as the engine normalized it (node `kind`s, not the authoring
 * mode keys); the Studio importer inverts that transform. Null when the body is
 * not a definition envelope, so callers can report the failure.
 */
export function normalizeWorkflowDefinition(raw) {
  var body = raw && typeof raw === "object" ? raw : null;
  if (!body || !body.workflow || typeof body.workflow !== "object") return null;
  return {
    workflow: body.workflow,
    filename: typeof body.filename === "string" ? body.filename : "",
    source: typeof body.source === "string" ? body.source : "",
  };
}

/** One run row (list or detail) -> the plugin's run view model. */
export function normalizeRun(raw) {
  var r = raw && typeof raw === "object" ? raw : {};
  return {
    id: r.id,
    workflow: r.workflow_name || "",
    status: r.status || "",
    outcome: r.outcome || null,
    message: r.user_message || "",
    codebaseId: r.codebase_id || null,
    conversationId: r.conversation_id || null,
    startedAt: r.started_at || null,
    completedAt: r.completed_at || null,
    lastActivityAt: r.last_activity_at || null,
  };
}

/** `GET /workflows/runs` body -> run view models. */
export function normalizeRunList(raw) {
  var list = raw && Array.isArray(raw.runs) ? raw.runs : [];
  return list.map(normalizeRun);
}

/** One row of the run detail `events` array -> { id, order, type, step, data, at }. */
export function normalizeRunEvent(raw) {
  var e = raw && typeof raw === "object" ? raw : {};
  return {
    id: e.id || e.event_order,
    order: e.event_order,
    type: e.event_type || "event",
    step: e.step_name || "",
    data: e.data,
    at: e.created_at || null,
  };
}

/** `GET /workflows/runs/{id}` body -> { run, events }. */
export function normalizeRunDetail(raw) {
  var d = raw && typeof raw === "object" ? raw : {};
  return {
    run: d.run && typeof d.run === "object" ? normalizeRun(d.run) : null,
    events: Array.isArray(d.events) ? d.events.map(normalizeRunEvent) : [],
  };
}

/** One entry of the artifact listing `files` array -> { path, size, modifiedAt }. */
export function normalizeArtifact(raw) {
  var f = raw && typeof raw === "object" ? raw : {};
  return {
    path: f.path,
    size: typeof f.size === "number" ? f.size : null,
    modifiedAt: f.modifiedAt || null,
  };
}

/**
 * `GET /runs/{id}/artifacts` body -> artifact view models, or null when the
 * body is not the expected listing (the panel reports that as an error).
 */
export function normalizeArtifactList(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.files)) return null;
  return raw.files.map(normalizeArtifact);
}

/** One row of `GET /conversations` -> { id, platformId, title, codebaseId }. */
export function normalizeConversation(raw) {
  var c = raw && typeof raw === "object" ? raw : {};
  return {
    id: c.id,
    platformId: c.platform_conversation_id || c.id,
    title: c.title || "",
    codebaseId: c.codebase_id || null,
  };
}

/** One row of `GET /conversations/{id}/messages` -> { role, content }. */
export function normalizeMessage(raw) {
  var m = raw && typeof raw === "object" ? raw : {};
  return {
    role: m.role === "assistant" ? "assistant" : "user",
    content: typeof m.content === "string" ? m.content : "",
  };
}

/**
 * `GET /providers` body -> [{ id, displayName, effortLevels }]. Archon wraps
 * the list in `{ providers }`; a bare array is accepted for older servers.
 */
export function normalizeProviders(raw) {
  var list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.providers) ? raw.providers : []);
  return list.map(function (p) {
    var q = p && typeof p === "object" ? p : {};
    return {
      id: q.id,
      displayName: q.displayName || q.id || "",
      effortLevels: Array.isArray(q.effortLevels) ? q.effortLevels : null,
    };
  });
}

/** `GET /config` or the `PATCH /config/assistants` reply -> { assistant, assistants, database }. */
export function normalizeConfig(raw) {
  var cfg = raw && raw.config && typeof raw.config === "object" ? raw.config : {};
  return {
    assistant: typeof cfg.assistant === "string" ? cfg.assistant : "",
    assistants: cfg.assistants && typeof cfg.assistants === "object" ? cfg.assistants : {},
    database: typeof raw.database === "string" ? raw.database : "",
  };
}

/** Body sent to `PATCH /config/assistants`. */
export function assistantsPayload(assistant, assistants) {
  return { assistant: assistant, assistants: assistants };
}

/** Body sent to `POST /workflows/validate` and `PUT /workflows/{name}`. */
export function definitionPayload(definition) {
  return { definition: definition };
}

/** Body sent to `POST /workflows/{name}/run`. */
export function launchPayload(conversationId, message) {
  return { conversationId: conversationId, message: message };
}

/** Body sent to `POST /conversations`. */
export function createConversationPayload(codebaseId) {
  return codebaseId ? { codebaseId: codebaseId } : {};
}

/** Body sent to `POST /codebases`: a URL registers a remote repo, anything else a local path. */
export function registerCodebasePayload(value) {
  var text = String(value).trim();
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(text) ? { url: text } : { path: text };
}

/** Body sent to a run control verb. */
export function runControlPayload(verb, text) {
  if (verb === "reject") return { reason: text || undefined };
  if (verb === "approve") return { comment: text || undefined };
  return {};
}

/** The conversation id a `POST /conversations` reply carries, or null. */
export function createdConversationId(raw) {
  return raw && typeof raw.conversationId === "string" && raw.conversationId ? raw.conversationId : null;
}

/** Body sent to `POST /conversations/{id}/message`. */
export function sendMessagePayload(text) {
  return { message: text };
}

/** Body sent to `PUT /codebases/{id}/env`. */
export function envVarPayload(key, value) {
  return { key: key, value: value };
}

/** `GET /codebases/{id}/env` body -> the key names (values are never returned). */
export function normalizeEnvKeys(raw) {
  return raw && Array.isArray(raw.keys) ? raw.keys : [];
}

/**
 * One frame of the per-conversation SSE stream -> { type, text, tool, locked, status }.
 * `type` is one of SSE_EVENTS.conversation or "" when unrecognized.
 */
export function normalizeConversationFrame(raw) {
  var f = raw && typeof raw === "object" ? raw : {};
  var type = typeof f.type === "string" && SSE_EVENTS.conversation.indexOf(f.type) !== -1 ? f.type : "";
  return {
    type: type,
    text: typeof f.content === "string" ? f.content : "",
    tool: typeof f.name === "string" ? f.name : "",
    locked: f.locked === true,
    status: typeof f.status === "string" ? f.status : "",
  };
}
