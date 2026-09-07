/**
 * Browser half of dsh-archon.
 *
 * M0+M1+M2 console: an **Archon** conversation view (full content area, beside
 * Chat / Trajectory / Terminal) that reads and drives a live Archon server
 * through the host relay (`/archon/*` → Archon REST, same-origin):
 *   - server health / version (GET /archon/api/health)
 *   - registered projects/codebases (GET /archon/api/codebases)
 *   - discoverable workflows (GET /archon/api/workflows)
 *   - recent workflow runs (GET /archon/api/workflows/runs) with per-run
 *     **controls**: approve / reject / resume / cancel / abandon
 *     (POST /archon/api/workflows/runs/{id}/{verb})
 *   - a per-run **detail panel**: run header + event timeline
 *     (GET /archon/api/workflows/runs/{id}) beside the run's artifacts
 *     (GET /archon/api/runs/{id}/artifacts) with inline previews of textual
 *     files (GET /archon/api/artifacts/{id}/{path})
 *   - a **launch panel**: pick a workflow, give it a message, run it
 *     (POST /archon/api/workflows/{name}/run)
 *   - a **Workflow Studio** (third console mode): author workflow definitions
 *     as a node graph — project-scoped discovery
 *     (GET /archon/api/workflows?cwd=), opening a definition
 *     (GET /archon/api/workflows/{name}?cwd=&source=), client + server
 *     validation (POST /archon/api/workflows/validate), and writes
 *     (PUT/DELETE /archon/api/workflows/{name}); bundled workflows open
 *     read-only with Save-as into the selected project
 *   - a **Chat** mode: pick or create a web conversation on a registered
 *     codebase, stream the routing agent's replies and tool activity over
 *     /archon/api/stream/{conversationId} (SSE), and send messages
 *     (POST /archon/api/conversations/{id}/message)
 * Live progress: an EventSource to /archon/api/stream/__dashboard__ invalidates
 * the runs + health views on workflow_status / dag_node frames, and re-fetches
 * an open run-detail panel.
 *
 * Settings: an **Archon** page (`settings.section` entry, id `archon`) inside
 * DSH's Settings shell mirrors Archon's own server settings through the same
 * relay — system health & concurrency, default assistant + per-provider model
 * defaults (PATCH /archon/api/config/assistants), platform connections, and
 * projects (list/add/remove + per-project env vars).
 *
 * Data-rule compliance (report 04 §7): display + direct user-gesture control of
 * the external engine — nothing reaches the DSH model, no session events are
 * emitted, and business state is kept in component state (never a slot store).
 *
 * Archon coupling: every Archon path and field name lives in the embedded
 * copy of lib/archon-surface.js (the "archon-surface" block) and the `Archon`
 * adapter right after it. The rest of this bundle works on the adapter's view
 * models, so an Archon release is absorbed in that one place.
 *
 * Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the id must
 * equal the package name. Only `react` is required from the module table.
 *
 * @module dsh-archon/client
 */

window.__ModuleLoader__.load({
  id: "dsh-archon",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    // ---- conversation view activation ------------------------------------
    // The Session header renders each registered View as a role="tab" button
    // labelled with the entry's `label`. The root-scoped sidebar icon cannot
    // reach the per-Session view store, so it activates the Archon view by
    // clicking that tab, retrying briefly while a session is still opening.

    var VIEW_LABEL = "Archon";

    function requestOpenArchon(sessionId) {
      if (!sessionId) return;
      var attempts = 0;
      function fire() {
        var tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
        for (var i = 0; i < tabs.length; i++) {
          if ((tabs[i].textContent || "").trim() === VIEW_LABEL) {
            if (tabs[i].getAttribute("aria-selected") !== "true") tabs[i].click();
            return;
          }
        }
        attempts += 1;
        if (attempts < 40) window.setTimeout(fire, 150);
      }
      fire();
    }

    // ---- Archon API (same-origin through the host relay) ------------------

    var API = "/archon/api";
    var HOST_STATE = "/api/dsh-archon/state";

    /** GET JSON from the relay; rejects on non-2xx with `__httpStatus` attached. */
    function getJson(path) {
      return fetch(API + path, { headers: { accept: "application/json" } })
        .then(function (r) {
          if (!r.ok) {
            var error = new Error("http " + r.status);
            error.__httpStatus = r.status;
            throw error;
          }
          return r.json();
        });
    }

    /** POST JSON to the relay; resolves the parsed body (may be an error envelope). */
    function postJson(path, body) {
      return fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? "{}" : JSON.stringify(body),
      }).then(function (r) {
        return r.json().catch(function () { return { status: r.status }; }).then(function (parsed) {
          parsed.__httpStatus = r.status;
          return parsed;
        });
      });
    }

    /**
     * JSON request with an explicit method (PATCH/PUT/DELETE) for the settings
     * page write paths. Resolves the parsed body with `__httpStatus` attached,
     * mirroring postJson so callers can read `res.error` on failure.
     */
    function sendJson(method, path, body) {
      return fetch(API + path, {
        method: method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(function (r) {
        return r.json().catch(function () { return { status: r.status }; }).then(function (parsed) {
          parsed.__httpStatus = r.status;
          return parsed;
        });
      });
    }

    function patchJson(path, body) { return sendJson("PATCH", path, body); }
    function putJson(path, body) { return sendJson("PUT", path, body); }
    function deleteJson(path, body) { return sendJson("DELETE", path, body); }

    // ---- Archon API surface ---------------------------------------------------
    // The block below is a verbatim copy of lib/archon-surface.js; edit that
    // file and run `node scripts/sync-client-surface.mjs`.

    // >>> archon-surface (generated from lib/archon-surface.js; run scripts/sync-client-surface.mjs)
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
    var ARCHON_PATHS = {
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
    var RUN_CONTROL_VERBS = ["approve", "reject", "resume", "cancel", "abandon"];

    /** SSE event names the plugin listens for on each stream. */
    var SSE_EVENTS = {
      dashboard: ["workflow_status", "dag_node"],
      conversation: ["text", "tool_call", "tool_result", "conversation_lock", "workflow_status"],
    };

    /**
     * Endpoints the plugin calls, as OpenAPI path templates. `tests/contract-check.mjs`
     * snapshots exactly these operations from Archon's `/api/openapi.json`; the
     * two streams and the artifact content route are not described by the spec.
     */
    var ENDPOINTS = [
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
    function normalizeHealth(raw) {
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
    function normalizeCodebase(raw) {
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
    function codebaseMatches(codebase, needle) {
      return codebase.defaultCwd === needle || codebase.repositoryUrl === needle || codebase.name === needle;
    }

    /** One entry of `GET /workflows` -> { name, source, description }. */
    function normalizeWorkflowEntry(raw) {
      var entry = raw && typeof raw === "object" ? raw : {};
      var w = entry.workflow && typeof entry.workflow === "object" ? entry.workflow : entry;
      return {
        name: w.name || "?",
        source: entry.source || "?",
        description: firstLine(w.description),
      };
    }

    /** `GET /workflows` body -> { entries, errorCount }. */
    function normalizeWorkflowList(raw) {
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
    function normalizeWorkflowDefinition(raw) {
      var body = raw && typeof raw === "object" ? raw : null;
      if (!body || !body.workflow || typeof body.workflow !== "object") return null;
      return {
        workflow: body.workflow,
        filename: typeof body.filename === "string" ? body.filename : "",
        source: typeof body.source === "string" ? body.source : "",
      };
    }

    /** One run row (list or detail) -> the plugin's run view model. */
    function normalizeRun(raw) {
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
    function normalizeRunList(raw) {
      var list = raw && Array.isArray(raw.runs) ? raw.runs : [];
      return list.map(normalizeRun);
    }

    /** One row of the run detail `events` array -> { id, order, type, step, data, at }. */
    function normalizeRunEvent(raw) {
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
    function normalizeRunDetail(raw) {
      var d = raw && typeof raw === "object" ? raw : {};
      return {
        run: d.run && typeof d.run === "object" ? normalizeRun(d.run) : null,
        events: Array.isArray(d.events) ? d.events.map(normalizeRunEvent) : [],
      };
    }

    /** One entry of the artifact listing `files` array -> { path, size, modifiedAt }. */
    function normalizeArtifact(raw) {
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
    function normalizeArtifactList(raw) {
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.files)) return null;
      return raw.files.map(normalizeArtifact);
    }

    /** One row of `GET /conversations` -> { id, platformId, title, codebaseId }. */
    function normalizeConversation(raw) {
      var c = raw && typeof raw === "object" ? raw : {};
      return {
        id: c.id,
        platformId: c.platform_conversation_id || c.id,
        title: c.title || "",
        codebaseId: c.codebase_id || null,
      };
    }

    /** One row of `GET /conversations/{id}/messages` -> { role, content }. */
    function normalizeMessage(raw) {
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
    function normalizeProviders(raw) {
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
    function normalizeConfig(raw) {
      var cfg = raw && raw.config && typeof raw.config === "object" ? raw.config : {};
      return {
        assistant: typeof cfg.assistant === "string" ? cfg.assistant : "",
        assistants: cfg.assistants && typeof cfg.assistants === "object" ? cfg.assistants : {},
        database: typeof raw.database === "string" ? raw.database : "",
      };
    }

    /** Body sent to `PATCH /config/assistants`. */
    function assistantsPayload(assistant, assistants) {
      return { assistant: assistant, assistants: assistants };
    }

    /** Body sent to `POST /workflows/validate` and `PUT /workflows/{name}`. */
    function definitionPayload(definition) {
      return { definition: definition };
    }

    /** Body sent to `POST /workflows/{name}/run`. */
    function launchPayload(conversationId, message) {
      return { conversationId: conversationId, message: message };
    }

    /** Body sent to `POST /conversations`. */
    function createConversationPayload(codebaseId) {
      return codebaseId ? { codebaseId: codebaseId } : {};
    }

    /** Body sent to `POST /codebases`: a URL registers a remote repo, anything else a local path. */
    function registerCodebasePayload(value) {
      var text = String(value).trim();
      return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(text) ? { url: text } : { path: text };
    }

    /** Body sent to a run control verb. */
    function runControlPayload(verb, text) {
      if (verb === "reject") return { reason: text || undefined };
      if (verb === "approve") return { comment: text || undefined };
      return {};
    }

    /** The conversation id a `POST /conversations` reply carries, or null. */
    function createdConversationId(raw) {
      return raw && typeof raw.conversationId === "string" && raw.conversationId ? raw.conversationId : null;
    }

    /** Body sent to `POST /conversations/{id}/message`. */
    function sendMessagePayload(text) {
      return { message: text };
    }

    /** Body sent to `PUT /codebases/{id}/env`. */
    function envVarPayload(key, value) {
      return { key: key, value: value };
    }

    /** `GET /codebases/{id}/env` body -> the key names (values are never returned). */
    function normalizeEnvKeys(raw) {
      return raw && Array.isArray(raw.keys) ? raw.keys : [];
    }

    /**
     * One frame of the per-conversation SSE stream -> { type, text, tool, locked, status }.
     * `type` is one of SSE_EVENTS.conversation or "" when unrecognized.
     */
    function normalizeConversationFrame(raw) {
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
    // <<< archon-surface

    // ---- Workflow Studio core -------------------------------------------------
    // The block below is a verbatim copy of lib/studio-core.js; edit that file
    // and run `node scripts/sync-client-surface.mjs`.

    // >>> studio-core (generated from lib/studio-core.js; run scripts/sync-client-surface.mjs)
    /** The node variants the Studio can author. Anything else imports as `opaque`. */
    var STUDIO_VARIANTS = ["prompt", "command", "bash", "script", "loop", "approval", "wait", "cancel"];

    /** Canvas geometry, shared by the layout function and the canvas renderer. */
    var NODE_W = 180;
    var NODE_H = 80;

    /**
     * Per-variant label and the authoring body a freshly added node starts with.
     * `defaults()` returns a new object every call — never share one between nodes.
     */
    var VARIANT_INFO = {
      prompt: {
        label: "Prompt",
        defaults: function () { return { prompt: "" }; },
      },
      command: {
        label: "Command",
        defaults: function () { return { command: "" }; },
      },
      bash: {
        label: "Bash",
        defaults: function () { return { bash: "" }; },
      },
      script: {
        label: "Script",
        defaults: function () { return { script: "", runtime: "bun" }; },
      },
      loop: {
        label: "Loop",
        defaults: function () {
          return { loop: { prompt: "", until: "COMPLETE", max_iterations: 10, fresh_context: false } };
        },
      },
      approval: {
        label: "Approval",
        defaults: function () { return { approval: { message: "Approve to continue?" } }; },
      },
      wait: {
        label: "Wait",
        defaults: function () { return { wait: { duration_ms: 60000 } }; },
      },
      cancel: {
        label: "Cancel",
        defaults: function () { return { cancel: "" }; },
      },
      opaque: {
        label: "Other",
        defaults: function () { return { raw: {} }; },
      },
    };

    /**
     * The wire keys that are graph/scheduling fields rather than a variant's mode
     * body, mirroring the engine's node base schema. Reference list only: the
     * importer does not partition by it (it removes the keys each variant consumes
     * and keeps everything else as `base`, so engine-only extras (`description`,
     * `pi`, `mutates_checkout`, `settingSources`, …) survive a round trip), and no
     * code reads this array. What actually drives the inspector is
     * `EDITABLE_BASE_KEYS` — the fields it exposes as controls — plus
     * `preservedBaseKeys()`, which reports the remaining base keys as preserved
     * but uneditable.
     */
    var BASE_FIELD_KEYS = [
      "depends_on", "when", "trigger_rule", "model", "provider", "context", "output_format",
      "allowed_tools", "denied_tools", "idle_timeout", "retry", "hooks", "mcp", "skills",
      "agents", "effort", "maxBudgetUsd", "systemPrompt", "fallbackModel", "betas", "sandbox",
      "always_run", "persist_session", "output_type",
    ];

    /** Base fields the inspector exposes directly; everything else is preserved silently. */
    var EDITABLE_BASE_KEYS = ["when", "trigger_rule", "provider", "model", "persist_session"];

    /** Variants whose AI fields (provider/model/persist_session) the engine honors. */
    var AI_VARIANTS = ["prompt", "command", "loop"];

    /** The authoring mode keys each variant owns, in the order they are exported. */
    var VARIANT_KEYS = {
      prompt: ["prompt"],
      command: ["command", "with"],
      bash: ["bash", "timeout"],
      script: ["script", "runtime", "deps", "timeout", "with"],
      loop: ["loop"],
      approval: ["approval"],
      wait: ["wait"],
      cancel: ["cancel"],
    };

    /** Node ids the engine accepts everywhere (`when` expressions, `depends_on`). */
    var ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

    // ---- small helpers ----------------------------------------------------------

    function isObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /** Deep structural copy of JSON-shaped data (the only shape a definition holds). */
    function cloneValue(value) {
      if (value === undefined) return undefined;
      return JSON.parse(JSON.stringify(value));
    }

    function textOf(value) {
      return typeof value === "string" ? value : "";
    }

    function isBlank(value) {
      return textOf(value).trim().length === 0;
    }

    function issue(severity, message, nodeId) {
      return { severity: severity, message: message, nodeId: nodeId || "" };
    }

    // ---- import: normalized (or authoring) wire nodes -> editable model ----------

    /**
     * Which variant an AUTHORING node is, by mode-key presence. The engine rejects a
     * node whose mode-key count is not exactly one, so for valid input any order
     * resolves the same; the priority below keeps malformed input deterministic.
     * Returns "" when no mode key is present at all.
     */
    function detectAuthoringVariant(node) {
      if (!isObject(node)) return "";
      if (node.loop !== undefined) return "loop";
      if (node.approval !== undefined) return "approval";
      if (node.wait !== undefined) return "wait";
      if (node.cancel !== undefined) return "cancel";
      if (node.bash !== undefined) return "bash";
      if (node.script !== undefined) return "script";
      if (node.command !== undefined) return "command";
      if (node.prompt !== undefined) return "prompt";
      return "";
    }

    /** Copy every own key of `node` except `id` and the ones `drop` names. */
    function restOf(node, drop) {
      var rest = {};
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === "id") continue;
        if (drop.indexOf(key) !== -1) continue;
        rest[key] = cloneValue(node[key]);
      }
      return rest;
    }

    /** Build `data` for an authoring-shaped node: its mode keys, in export order. */
    function authoringData(variant, node) {
      var data = {};
      var keys = VARIANT_KEYS[variant] || [];
      for (var i = 0; i < keys.length; i++) {
        if (node[keys[i]] !== undefined) data[keys[i]] = cloneValue(node[keys[i]]);
      }
      return data;
    }

    /** Rebuild the authoring `approval:` block from a normalized gate node. */
    function approvalFromGate(node) {
      var approval = { message: textOf(node.message) };
      if (node.captureResponse === true) approval.capture_response = true;
      if (node.decisionsAuthored === true) {
        if (node.decisions !== undefined) approval.decisions = cloneValue(node.decisions);
        return approval;
      }
      // Not authored: `decisions` is either the engine's default pair (drop it) or
      // the pair it synthesized from a legacy `on_reject:` (rebuild that instead).
      var decisions = Array.isArray(node.decisions) ? node.decisions : [];
      for (var i = 0; i < decisions.length; i++) {
        var decision = decisions[i];
        if (decision && decision.id === "reject" && isObject(decision.rework)) {
          var onReject = { prompt: decision.rework.prompt };
          if (decision.rework.maxAttempts !== undefined) onReject.max_attempts = decision.rework.maxAttempts;
          approval.on_reject = onReject;
          break;
        }
      }
      return approval;
    }

    /** An array that is a list of nodes: every item is an object with a string id. */
    function isNodeList(value) {
      if (!Array.isArray(value) || value.length === 0) return false;
      for (var i = 0; i < value.length; i++) {
        if (!isObject(value[i]) || typeof value[i].id !== "string") return false;
      }
      return true;
    }

    /**
     * An opaque body can nest a whole sub-DAG — `loop_group: { nodes: [...] }` — and
     * the server normalizes those children exactly like top-level ones. Copying them
     * through untouched makes the save fail validation (a nested bash child arrives
     * as `runtime:'sh'`, a nested wait child carries the injected `output_format`),
     * so every nested node list is converted back to authoring shape too.
     */
    function importOpaqueBody(value, issues) {
      if (Array.isArray(value)) {
        return value.map(function (item) { return importOpaqueBody(item, issues); });
      }
      if (!isObject(value)) return value;
      var out = {};
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === "nodes" && isNodeList(value[key])) {
          out[key] = value[key].map(function (node) { return exportNode(importNode(node, issues)); });
        } else {
          out[key] = importOpaqueBody(value[key], issues);
        }
      }
      return out;
    }

    /**
     * One wire node -> `{ id, variant, base, data }`, inverting the engine transform.
     * Accepts an authoring-shaped node too (no `kind`), so a New-seeded model and a
     * re-imported export both travel the same code path. Unknown kinds become
     * `opaque` nodes: `depends_on`/`when` are lifted out for the canvas and the rest
     * of the body is preserved verbatim in `data.raw`.
     */
    function importNode(raw, issues) {
      var node = isObject(raw) ? raw : {};
      var id = typeof node.id === "string" ? node.id : String(node.id === undefined ? "" : node.id);
      var kind = typeof node.kind === "string" ? node.kind : "";
      var variant = "";
      var data = null;
      var consumed = ["kind"];

      if (kind === "") {
        variant = detectAuthoringVariant(node);
        if (variant) {
          data = authoringData(variant, node);
          consumed = consumed.concat(VARIANT_KEYS[variant]);
        }
      } else if (kind === "agent") {
        var source = isObject(node.source) ? node.source : {};
        consumed.push("source");
        if (source.kind === "command") {
          variant = "command";
          data = { command: textOf(source.name) };
          if (source["with"] !== undefined) data["with"] = cloneValue(source["with"]);
        } else {
          variant = "prompt";
          data = { prompt: textOf(source.prompt) };
        }
      } else if (kind === "exec") {
        consumed = consumed.concat(["script", "runtime", "deps", "timeout", "with"]);
        if (node.runtime === "sh") {
          variant = "bash";
          data = { bash: textOf(node.script) };
          if (node.timeout !== undefined) data.timeout = node.timeout;
        } else {
          variant = "script";
          data = { script: textOf(node.script), runtime: node.runtime };
          if (node.deps !== undefined) data.deps = cloneValue(node.deps);
          if (node.timeout !== undefined) data.timeout = node.timeout;
          if (node["with"] !== undefined) data["with"] = cloneValue(node["with"]);
        }
      } else if (kind === "gate") {
        variant = "approval";
        consumed = consumed.concat(["message", "decisions", "decisionsAuthored", "captureResponse"]);
        data = { approval: approvalFromGate(node) };
      } else if (kind === "wait") {
        variant = "wait";
        // The engine injects a fixed `output_format` on every wait node; re-sending
        // it is noise the author never wrote, so it is dropped on the way in.
        consumed = consumed.concat(["wait", "output_format"]);
        data = { wait: cloneValue(node.wait) };
      } else if (kind === "halt") {
        variant = "cancel";
        consumed.push("reason");
        data = { cancel: textOf(node.reason) };
      } else if (kind === "loop") {
        variant = "loop";
        consumed.push("loop");
        data = { loop: cloneValue(node.loop) };
      }

      if (!variant || !data) {
        // No inversion for this node: keep it whole. `include`, `workflow`,
        // `loop_group` and `compose_fan_out` all land here and round-trip verbatim.
        var kept = importOpaqueBody(restOf(node, ["kind", "depends_on", "when"]), issues);
        var opaqueBase = {};
        if (node.depends_on !== undefined) opaqueBase.depends_on = cloneValue(node.depends_on);
        if (node.when !== undefined) opaqueBase.when = cloneValue(node.when);
        issues.push(issue(
          "warning",
          "Node '" + id + "' is a " + (kind ? "'" + kind + "'" : "kind the Studio does not author") +
            " node: its graph fields are editable and the rest is preserved as written.",
          id,
        ));
        return { id: id, variant: "opaque", base: opaqueBase, data: { raw: kept } };
      }

      if (variant === "script" && node.runtime === undefined) {
        issues.push(issue("error", "Node '" + id + "' is a script node with no runtime; editing it as 'bun'.", id));
        data.runtime = "bun";
      }

      return { id: id, variant: variant, base: restOf(node, consumed), data: data };
    }

    /**
     * A workflow definition (normalized or authoring) -> `{ model, issues }`.
     * `meta` keeps every top-level key that is not `name`/`description`/`nodes`, in
     * document order, so it re-exports between `description:` and `nodes:`.
     */
    function importDefinition(definition) {
      var def = isObject(definition) ? definition : {};
      var issues = [];
      var meta = {};
      var keys = Object.keys(def);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === "name" || key === "description" || key === "nodes") continue;
        meta[key] = cloneValue(def[key]);
      }
      var rawNodes = Array.isArray(def.nodes) ? def.nodes : [];
      var nodes = [];
      for (var n = 0; n < rawNodes.length; n++) nodes.push(importNode(rawNodes[n], issues));
      return {
        model: {
          name: textOf(def.name),
          description: def.description === undefined ? "" : textOf(def.description),
          meta: meta,
          nodes: nodes,
        },
        issues: issues,
      };
    }

    // ---- export: model -> authoring definition ----------------------------------

    /**
     * One model node -> a sparse authoring node, keys in `{ id, ...base, ...data }`
     * order. `undefined` values and an empty `depends_on` are dropped, matching the
     * engine transform's own sparsity.
     */
    function exportNode(node) {
      var out = {};
      out.id = node.id;
      var base = isObject(node.base) ? node.base : {};
      var baseKeys = Object.keys(base);
      for (var i = 0; i < baseKeys.length; i++) {
        var key = baseKeys[i];
        var value = base[key];
        if (value === undefined) continue;
        if (key === "depends_on" && (!Array.isArray(value) || value.length === 0)) continue;
        out[key] = cloneValue(value);
      }
      var body = node.variant === "opaque"
        ? (node.data && isObject(node.data.raw) ? node.data.raw : {})
        : (isObject(node.data) ? node.data : {});
      var bodyKeys = Object.keys(body);
      for (var b = 0; b < bodyKeys.length; b++) {
        var bodyKey = bodyKeys[b];
        if (bodyKey === "id" || bodyKey === "kind") continue;
        if (body[bodyKey] === undefined) continue;
        out[bodyKey] = cloneValue(body[bodyKey]);
      }
      return out;
    }

    /**
     * The model -> the authoring JSON that `POST /workflows/validate` and
     * `PUT /workflows/{name}` accept. Key order is `name`, `description`, meta,
     * `nodes` — the order the server's YAML writer preserves.
     */
    function exportDefinition(model) {
      var source = isObject(model) ? model : {};
      var out = {};
      out.name = textOf(source.name);
      if (source.description !== undefined && source.description !== "") out.description = source.description;
      var meta = isObject(source.meta) ? source.meta : {};
      var metaKeys = Object.keys(meta);
      for (var i = 0; i < metaKeys.length; i++) {
        if (meta[metaKeys[i]] === undefined) continue;
        out[metaKeys[i]] = cloneValue(meta[metaKeys[i]]);
      }
      var nodes = Array.isArray(source.nodes) ? source.nodes : [];
      var exported = [];
      for (var n = 0; n < nodes.length; n++) exported.push(exportNode(nodes[n]));
      out.nodes = exported;
      return out;
    }

    // ---- client-side validation -------------------------------------------------

    function checkLoop(node, issues) {
      var loop = isObject(node.data.loop) ? node.data.loop : {};
      var hasPrompt = loop.prompt !== undefined;
      var hasCommand = loop.command !== undefined;
      if (hasPrompt && hasCommand) {
        issues.push(issue("error", "Node '" + node.id + "': loop accepts exactly one of 'prompt' or 'command', not both.", node.id));
      } else if (hasCommand) {
        if (isBlank(loop.command)) issues.push(issue("error", "Node '" + node.id + "': loop requires a command name.", node.id));
      } else if (isBlank(loop.prompt)) {
        issues.push(issue("error", "Node '" + node.id + "': loop requires a prompt (or a command file).", node.id));
      }
      var channels = ["until", "until_bash", "until_field"];
      var declared = 0;
      for (var i = 0; i < channels.length; i++) {
        if (loop[channels[i]] === undefined) continue;
        declared += 1;
        if (isBlank(loop[channels[i]])) {
          issues.push(issue("error", "Node '" + node.id + "': loop '" + channels[i] + "' must not be blank.", node.id));
        }
      }
      if (declared === 0) {
        issues.push(issue("error", "Node '" + node.id + "': loop requires a completion channel ('until', 'until_bash', or 'until_field').", node.id));
      }
      var max = loop.max_iterations;
      if (typeof max !== "number" || !isFinite(max) || Math.floor(max) !== max || max <= 0) {
        issues.push(issue("error", "Node '" + node.id + "': loop requires a positive integer 'max_iterations'.", node.id));
      }
    }

    function checkWait(node, issues) {
      var wait = isObject(node.data.wait) ? node.data.wait : {};
      var modes = ["duration_ms", "until", "event", "attention"];
      var present = [];
      for (var i = 0; i < modes.length; i++) {
        if (wait[modes[i]] !== undefined) present.push(modes[i]);
      }
      if (present.length !== 1) {
        issues.push(issue("error", "Node '" + node.id + "': wait requires exactly one of 'duration_ms', 'until', 'event', or 'attention'.", node.id));
      }
      if (wait.duration_ms !== undefined) {
        var ms = wait.duration_ms;
        if (typeof ms !== "number" || !isFinite(ms) || Math.floor(ms) !== ms || ms <= 0) {
          issues.push(issue("error", "Node '" + node.id + "': wait 'duration_ms' must be a positive integer.", node.id));
        }
      }
      if (wait.event !== undefined) {
        if (isBlank(wait.event)) issues.push(issue("error", "Node '" + node.id + "': wait 'event' must not be empty.", node.id));
        var deadline = wait.deadline_ms;
        if (typeof deadline !== "number" || !isFinite(deadline) || Math.floor(deadline) !== deadline || deadline <= 0) {
          issues.push(issue("error", "Node '" + node.id + "': an event wait requires a positive integer 'deadline_ms'.", node.id));
        }
      } else if (wait.deadline_ms !== undefined) {
        issues.push(issue("error", "Node '" + node.id + "': 'deadline_ms' is only supported on event waits.", node.id));
      }
      if (wait.until !== undefined && isBlank(wait.until)) {
        issues.push(issue("error", "Node '" + node.id + "': wait 'until' must not be empty.", node.id));
      }
      if (wait.attention !== undefined && isBlank(wait.attention)) {
        issues.push(issue("error", "Node '" + node.id + "': wait 'attention' must not be empty.", node.id));
      }
    }

    function checkVariant(node, issues) {
      if (node.variant === "prompt" && isBlank(node.data.prompt)) {
        issues.push(issue("error", "Node '" + node.id + "': prompt must not be empty.", node.id));
      } else if (node.variant === "command" && isBlank(node.data.command)) {
        issues.push(issue("error", "Node '" + node.id + "': command must not be empty.", node.id));
      } else if (node.variant === "bash" && isBlank(node.data.bash)) {
        issues.push(issue("error", "Node '" + node.id + "': bash script must not be empty.", node.id));
      } else if (node.variant === "script") {
        if (isBlank(node.data.script)) issues.push(issue("error", "Node '" + node.id + "': script must not be empty.", node.id));
        if (node.data.runtime !== "bun" && node.data.runtime !== "uv") {
          issues.push(issue("error", "Node '" + node.id + "': script requires runtime 'bun' or 'uv'.", node.id));
        }
      } else if (node.variant === "approval") {
        var approval = isObject(node.data.approval) ? node.data.approval : {};
        if (isBlank(approval.message)) issues.push(issue("error", "Node '" + node.id + "': approval requires a message.", node.id));
      } else if (node.variant === "cancel" && isBlank(node.data.cancel)) {
        issues.push(issue("error", "Node '" + node.id + "': cancel requires a reason.", node.id));
      } else if (node.variant === "loop") {
        checkLoop(node, issues);
      } else if (node.variant === "wait") {
        checkWait(node, issues);
      }
    }

    /**
     * Depth-first three-color walk over `depends_on`. A cycle is reported once per
     * node it re-enters — the dedup is keyed on the re-entered node, not on the
     * individual edge, so a node reached through several back edges is reported
     * once, and a node reachable through only one back edge is still reported once.
     */
    function checkCycles(nodes, known, issues) {
      var color = Object.create(null);
      var deps = Object.create(null);
      var i;
      for (i = 0; i < nodes.length; i++) {
        color[nodes[i].id] = 0;
        deps[nodes[i].id] = Array.isArray(nodes[i].base && nodes[i].base.depends_on) ? nodes[i].base.depends_on : [];
      }
      var reported = Object.create(null);
      function visit(id) {
        color[id] = 1;
        var list = deps[id] || [];
        for (var d = 0; d < list.length; d++) {
          var dep = list[d];
          if (!known[dep]) continue; // unknown refs are reported separately
          if (color[dep] === 1) {
            if (!reported[dep]) {
              reported[dep] = true;
              issues.push(issue("error", "Dependency cycle detected involving node '" + dep + "'.", dep));
            }
          } else if (color[dep] === 0) {
            visit(dep);
          }
        }
        color[id] = 2;
      }
      for (i = 0; i < nodes.length; i++) {
        if (color[nodes[i].id] === 0) visit(nodes[i].id);
      }
    }

    /**
     * Every problem the Studio can see without the server: workflow name and
     * description, node-id hygiene, `depends_on` integrity, cycles, and the
     * per-variant required fields the engine enforces. Errors block Save; warnings
     * are advisory (the id-shape rule is a warning because the engine accepts any
     * non-empty id, but `when` expressions and `depends_on` read much better with
     * identifier-shaped ones).
     */
    function validateModel(model) {
      var issues = [];
      var source = isObject(model) ? model : {};
      var nodes = Array.isArray(source.nodes) ? source.nodes : [];
      if (isBlank(source.name)) issues.push(issue("error", "The workflow needs a name."));
      if (isBlank(source.description)) issues.push(issue("error", "The workflow needs a description (the engine rejects a definition without one)."));
      if (nodes.length === 0) issues.push(issue("error", "The workflow needs at least one node."));

      var known = Object.create(null);
      var seen = Object.create(null);
      var i;
      for (i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var id = textOf(node.id).trim();
        if (id === "") {
          issues.push(issue("error", "A node has an empty id."));
          continue;
        }
        if (seen[id]) issues.push(issue("error", "Duplicate node id '" + id + "'.", id));
        seen[id] = true;
        known[id] = true;
        if (!ID_PATTERN.test(id)) {
          issues.push(issue("warning", "Node id '" + id + "' is not identifier-shaped (letter or underscore, then letters, digits, '-' or '_').", id));
        }
      }

      for (i = 0; i < nodes.length; i++) {
        var current = nodes[i];
        var deps = current.base && Array.isArray(current.base.depends_on) ? current.base.depends_on : [];
        for (var d = 0; d < deps.length; d++) {
          if (!known[deps[d]]) {
            issues.push(issue("error", "Node '" + current.id + "' depends on unknown node '" + deps[d] + "'.", current.id));
          }
        }
        if (current.variant !== "opaque") checkVariant(current, issues);
      }

      checkCycles(nodes, known, issues);
      return issues;
    }

    /** The subset of issues that blocks a save. */
    function blockingIssues(issues) {
      return (issues || []).filter(function (i) { return i && i.severity === "error"; });
    }

    // ---- YAML preview -----------------------------------------------------------

    /** Word scalars a YAML parser may re-type (YAML 1.1 boolean spellings included). */
    var AMBIGUOUS_WORDS = ["true", "false", "null", "~", "yes", "no", "on", "off", "nan"];

    /** Number-like spellings YAML re-types: ints, floats, exponents, hex, octal, .inf/.nan. */
    var NUMERIC_LIKE = /^[+-]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.(?:inf|nan))$/i;

    var LEADING_SPECIALS = ["{", "[", "&", "*", "-", "+", "?", "!", "%", "@", "`"];

    function quoteIfAmbiguous(value) {
      if (value === "" || AMBIGUOUS_WORDS.indexOf(value.toLowerCase()) !== -1 || NUMERIC_LIKE.test(value)) {
        return JSON.stringify(value);
      }
      if (value.indexOf(":") !== -1 || value.indexOf("#") !== -1 || value.indexOf('"') !== -1 || value.indexOf("'") !== -1) {
        return JSON.stringify(value);
      }
      if (LEADING_SPECIALS.indexOf(value.charAt(0)) !== -1) return JSON.stringify(value);
      if (value !== value.trim()) return JSON.stringify(value);
      return value;
    }

    function pad(width) {
      var out = "";
      for (var i = 0; i < width; i++) out += " ";
      return out;
    }

    function serializeValue(value, indent) {
      if (value === null || value === undefined) return "null";
      if (typeof value === "boolean" || typeof value === "number") return String(value);
      if (typeof value === "string") {
        if (value.indexOf("\n") !== -1) {
          var block = pad(indent + 2);
          return "|\n" + value.split("\n").map(function (line) { return line === "" ? "" : block + line; }).join("\n");
        }
        return quoteIfAmbiguous(value);
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        var itemPad = pad(indent + 2);
        return "\n" + value.map(function (item) {
          return itemPad + "- " + serializeValue(item, indent + 4);
        }).join("\n");
      }
      if (typeof value === "object") {
        var keys = Object.keys(value).filter(function (key) { return value[key] !== undefined; });
        if (keys.length === 0) return "{}";
        var keyPad = pad(indent + 2);
        return "\n" + keys.map(function (key) {
          return keyLine(keyPad, key, value[key], indent + 2);
        }).join("\n");
      }
      return JSON.stringify(value);
    }

    /**
     * `key: value` after `prefix`, dropping the space when the value renders as an
     * indented block (which opens with its own newline) so no line ends in space.
     */
    function keyLine(prefix, key, value, indent) {
      var rendered = serializeValue(value, indent);
      return rendered.charAt(0) === "\n" ? prefix + key + ":" + rendered : prefix + key + ": " + rendered;
    }

    function serializeNode(node, indent) {
      var nodePad = pad(indent);
      var keys = Object.keys(node);
      var ordered = ["id"];
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] !== "id") ordered.push(keys[i]);
      }
      var lines = [];
      for (var k = 0; k < ordered.length; k++) {
        var key = ordered[k];
        if (node[key] === undefined) continue;
        var prefix = lines.length === 0 ? nodePad + "- " : nodePad + "  ";
        lines.push(keyLine(prefix, key, node[key], indent + 2));
      }
      return lines.join("\n");
    }

    /**
     * An authoring definition -> the YAML preview string. Preview only: the server
     * writes the file itself from the JSON we PUT, so this shows the same content
     * and key order without claiming to be byte-identical to what lands on disk.
     */
    function serializeYamlPreview(definition) {
      var def = isObject(definition) ? definition : {};
      var lines = [];
      lines.push(keyLine("", "name", def.name === undefined ? "" : def.name, 0));
      if (def.description !== undefined && def.description !== "") {
        lines.push(keyLine("", "description", def.description, 0));
      }
      var keys = Object.keys(def);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === "name" || key === "description" || key === "nodes") continue;
        if (def[key] === undefined) continue;
        lines.push(keyLine("", key, def[key], 0));
      }
      lines.push("");
      lines.push("nodes:");
      var nodes = Array.isArray(def.nodes) ? def.nodes : [];
      for (var n = 0; n < nodes.length; n++) lines.push(serializeNode(nodes[n], 2));
      return lines.join("\n") + "\n";
    }

    // ---- graph: edges and layout ------------------------------------------------

    /** The canvas id of the edge that `target`'s `depends_on` entry for `source` draws. */
    function edgeIdFor(source, target) {
      return source + "->" + target;
    }

    /**
     * Model -> canvas edges. One edge per resolvable `depends_on` entry; entries
     * naming an unknown node are left in the model (and reported by `validateModel`)
     * but not drawn. `dashed` marks an edge into a `when`-gated node.
     */
    function edgesFromModel(model) {
      var source = isObject(model) ? model : {};
      var nodes = Array.isArray(source.nodes) ? source.nodes : [];
      var known = Object.create(null);
      var i;
      for (i = 0; i < nodes.length; i++) known[nodes[i].id] = true;
      var edges = [];
      for (i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var base = isObject(node.base) ? node.base : {};
        var deps = Array.isArray(base.depends_on) ? base.depends_on : [];
        var dashed = !isBlank(base.when);
        for (var d = 0; d < deps.length; d++) {
          if (!known[deps[d]]) continue;
          edges.push({ id: edgeIdFor(deps[d], node.id), source: deps[d], target: node.id, dashed: dashed });
        }
      }
      return edges;
    }

    /**
     * Layered top-down layout: a node's rank is one past its deepest dependency, and
     * its column is its index within that rank. Positions are never persisted — the
     * wire node has no position field — so this runs on open and on Auto-arrange.
     */
    function layoutGraph(nodes, edges) {
      var list = Array.isArray(nodes) ? nodes : [];
      var incoming = Object.create(null);
      var i;
      for (i = 0; i < list.length; i++) incoming[list[i].id] = [];
      var links = Array.isArray(edges) ? edges : [];
      for (i = 0; i < links.length; i++) {
        var edge = links[i];
        if (incoming[edge.target] && incoming[edge.source] !== undefined) incoming[edge.target].push(edge.source);
      }
      var rank = Object.create(null);
      var state = Object.create(null);
      function rankOf(id) {
        if (state[id] === 2) return rank[id];
        if (state[id] === 1) return 0; // a cycle: break it rather than recurse forever
        state[id] = 1;
        var best = 0;
        var deps = incoming[id] || [];
        for (var d = 0; d < deps.length; d++) {
          var candidate = rankOf(deps[d]) + 1;
          if (candidate > best) best = candidate;
        }
        state[id] = 2;
        rank[id] = best;
        return best;
      }
      for (i = 0; i < list.length; i++) rankOf(list[i].id);
      var used = Object.create(null);
      var positions = Object.create(null);
      for (i = 0; i < list.length; i++) {
        var nodeId = list[i].id;
        var row = rank[nodeId] || 0;
        var column = used[row] || 0;
        used[row] = column + 1;
        positions[nodeId] = { x: column * (NODE_W + 40), y: row * (NODE_H + 80) };
      }
      return positions;
    }

    // ---- model edits (pure: every one returns a new model) ----------------------

    function cloneModel(model) {
      var source = isObject(model) ? model : {};
      var nodes = Array.isArray(source.nodes) ? source.nodes : [];
      return {
        name: source.name,
        description: source.description,
        meta: source.meta,
        nodes: nodes.map(function (node) {
          return { id: node.id, variant: node.variant, base: node.base, data: node.data };
        }),
      };
    }

    /** Index of `id` in the model's node list, or -1. */
    function findNodeIndex(model, id) {
      var nodes = model && Array.isArray(model.nodes) ? model.nodes : [];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].id === id) return i;
      }
      return -1;
    }

    /** A node id of the shape `<variant>-<n>` that no node in `model` uses yet. */
    function uniqueNodeId(variant, model) {
      var taken = Object.create(null);
      var nodes = model && Array.isArray(model.nodes) ? model.nodes : [];
      for (var i = 0; i < nodes.length; i++) taken[nodes[i].id] = true;
      var n = 1;
      while (taken[variant + "-" + n]) n += 1;
      return variant + "-" + n;
    }

    /** Append a node of `variant` with the registry defaults. */
    function addNode(model, variant) {
      var next = cloneModel(model);
      var info = VARIANT_INFO[variant] || VARIANT_INFO.prompt;
      var node = { id: uniqueNodeId(variant, next), variant: variant, base: {}, data: info.defaults() };
      next.nodes = next.nodes.concat([node]);
      return { model: next, node: node };
    }

    /** Replace one node's fields through `change(node)`, which returns the new node. */
    function updateNode(model, id, change) {
      var next = cloneModel(model);
      var index = findNodeIndex(next, id);
      if (index === -1) return next;
      next.nodes = next.nodes.slice();
      next.nodes[index] = change(next.nodes[index]);
      return next;
    }

    /** Set (or, with `value === undefined`, delete) one key of a node's `base`. */
    function setBaseField(model, id, key, value) {
      return updateNode(model, id, function (node) {
        var base = {};
        var keys = Object.keys(node.base || {});
        for (var i = 0; i < keys.length; i++) base[keys[i]] = node.base[keys[i]];
        if (value === undefined) delete base[key];
        else base[key] = value;
        return { id: node.id, variant: node.variant, base: base, data: node.data };
      });
    }

    /** Set (or delete) one key of a node's authoring body, or of its nested block. */
    function setDataField(model, id, path, value) {
      var keys = Array.isArray(path) ? path : [path];
      return updateNode(model, id, function (node) {
        var data = {};
        var own = Object.keys(node.data || {});
        var i;
        for (i = 0; i < own.length; i++) data[own[i]] = node.data[own[i]];
        if (keys.length === 1) {
          if (value === undefined) delete data[keys[0]];
          else data[keys[0]] = value;
        } else {
          var block = {};
          var nested = isObject(data[keys[0]]) ? data[keys[0]] : {};
          var nestedKeys = Object.keys(nested);
          for (i = 0; i < nestedKeys.length; i++) block[nestedKeys[i]] = nested[nestedKeys[i]];
          if (value === undefined) delete block[keys[1]];
          else block[keys[1]] = value;
          data[keys[0]] = block;
        }
        return { id: node.id, variant: node.variant, base: node.base, data: data };
      });
    }

    /** Rename a node, rewriting every `depends_on` that referenced the old id. */
    function renameNode(model, from, to) {
      var next = cloneModel(model);
      next.nodes = next.nodes.map(function (node) {
        var base = node.base;
        var deps = base && Array.isArray(base.depends_on) ? base.depends_on : null;
        if (deps && deps.indexOf(from) !== -1) {
          var rewritten = {};
          var keys = Object.keys(base);
          for (var i = 0; i < keys.length; i++) rewritten[keys[i]] = base[keys[i]];
          rewritten.depends_on = deps.map(function (dep) { return dep === from ? to : dep; });
          base = rewritten;
        }
        return { id: node.id === from ? to : node.id, variant: node.variant, base: base, data: node.data };
      });
      return next;
    }

    /** Remove a node and strip it from every other node's `depends_on`. */
    function removeNode(model, id) {
      var next = cloneModel(model);
      next.nodes = next.nodes
        .filter(function (node) { return node.id !== id; })
        .map(function (node) {
          var deps = node.base && Array.isArray(node.base.depends_on) ? node.base.depends_on : null;
          if (!deps || deps.indexOf(id) === -1) return node;
          var base = {};
          var keys = Object.keys(node.base);
          for (var i = 0; i < keys.length; i++) base[keys[i]] = node.base[keys[i]];
          base.depends_on = deps.filter(function (dep) { return dep !== id; });
          return { id: node.id, variant: node.variant, base: base, data: node.data };
        });
      return next;
    }

    /**
     * Add `source` to `target`'s `depends_on`. Self-edges and duplicates are refused
     * (the model comes back unchanged), matching the canvas's connect affordance.
     */
    function connectNodes(model, source, target) {
      if (source === target) return model;
      var index = findNodeIndex(model, target);
      if (index === -1 || findNodeIndex(model, source) === -1) return model;
      var deps = model.nodes[index].base && Array.isArray(model.nodes[index].base.depends_on)
        ? model.nodes[index].base.depends_on
        : [];
      if (deps.indexOf(source) !== -1) return model;
      return setBaseField(model, target, "depends_on", deps.concat([source]));
    }

    /** Drop `source` from `target`'s `depends_on`, deleting the key when it empties. */
    function disconnectNodes(model, source, target) {
      var index = findNodeIndex(model, target);
      if (index === -1) return model;
      var base = model.nodes[index].base || {};
      var deps = Array.isArray(base.depends_on) ? base.depends_on : [];
      var kept = deps.filter(function (dep) { return dep !== source; });
      if (kept.length === deps.length) return model;
      return setBaseField(model, target, "depends_on", kept.length ? kept : undefined);
    }

    // ---- names, rename planning, and the New-workflow seed ----------------------

    /**
     * The server's own rule for a writable workflow name (`isValidCommandName`):
     * non-empty, no path separators at all, no `..`, and not starting with a dot.
     * Dots mid-name are fine — the server accepts them.
     */
    function isValidWorkflowName(name) {
      var text = typeof name === "string" ? name : "";
      if (text === "" || text.charAt(0) === ".") return false;
      if (text.indexOf("/") !== -1 || text.indexOf("\\") !== -1 || text.indexOf("..") !== -1) return false;
      return true;
    }

    /**
     * Whether a rename can go ahead. `PUT` silently overwrites a colliding file and
     * never returns 409, so the collision guard has to live here.
     */
    function planRename(from, to, existingNames) {
      if (!isValidWorkflowName(to)) return { ok: false, reason: "invalid-name" };
      if (to === from) return { ok: false, reason: "noop" };
      var names = Array.isArray(existingNames) ? existingNames : [];
      if (names.indexOf(to) !== -1) return { ok: false, reason: "collision" };
      return { ok: true };
    }

    /** Why a name was refused, in words a user can act on. */
    function renameReasonMessage(reason, name) {
      if (reason === "invalid-name") {
        return "'" + name + "' is not a valid workflow name (no '/', '\\' or '..', and it cannot start with '.').";
      }
      if (reason === "collision") return "A workflow named '" + name + "' already exists here.";
      if (reason === "noop") return "That is already the workflow's name.";
      return "That name cannot be used.";
    }

    /** The smallest definition the server accepts, in authoring shape. */
    function newWorkflowSeed(name) {
      return {
        name: name,
        description: "New workflow.",
        nodes: [{ id: "step-1", prompt: "Describe what this step should do." }],
      };
    }

    /** Bundled workflows are read-only; everything else edits in place. */
    function isReadOnlySource(source) {
      return source === "bundled";
    }

    /** Where a save writes: a global workflow stays global, everything else is a project file. */
    function saveTargetFor(source) {
      return source === "global" ? "global" : "project";
    }

    /**
     * The issues a rejected `POST /workflows/validate` should show. The response is
     * HTTP 200 with `valid:false`, and its `errors` array can be empty — so this
     * always yields at least one issue rather than silently clearing the panel.
     */
    function serverIssues(errors) {
      var list = Array.isArray(errors) ? errors : [];
      var issues = [];
      for (var i = 0; i < list.length; i++) {
        issues.push(issue("error", typeof list[i] === "string" ? list[i] : JSON.stringify(list[i])));
      }
      if (issues.length === 0) {
        issues.push(issue("error", "The server rejected the workflow but returned no error details."));
      }
      return issues;
    }

    /** A one-line summary of a node for the canvas card. */
    function nodeSummary(node) {
      if (!node) return "";
      var data = node.data || {};
      var text = "";
      if (node.variant === "prompt") text = textOf(data.prompt);
      else if (node.variant === "command") text = textOf(data.command);
      else if (node.variant === "bash") text = textOf(data.bash);
      else if (node.variant === "script") text = textOf(data.script);
      else if (node.variant === "cancel") text = textOf(data.cancel);
      else if (node.variant === "loop") text = textOf(isObject(data.loop) ? (data.loop.prompt || data.loop.command) : "");
      else if (node.variant === "approval") text = textOf(isObject(data.approval) ? data.approval.message : "");
      else if (node.variant === "wait") text = isObject(data.wait) ? Object.keys(data.wait).join(", ") : "";
      else if (node.variant === "opaque") text = isObject(data.raw) ? Object.keys(data.raw).join(", ") : "";
      var line = text.split("\n")[0] || "";
      return line.length > 46 ? line.slice(0, 45) + "…" : line;
    }

    /** Base keys on a node that the inspector preserves but cannot edit. */
    function preservedBaseKeys(node) {
      var base = node && isObject(node.base) ? node.base : {};
      return Object.keys(base).filter(function (key) {
        return key !== "depends_on" && EDITABLE_BASE_KEYS.indexOf(key) === -1;
      });
    }
    // <<< studio-core

    /**
     * Relay-backed Archon calls returning the plugin's own view models. This
     * object and the surface block above are the only code that knows Archon's
     * routes and row shapes; everything else reads normalized fields.
     */
    var Archon = {
      health: function () { return getJson(ARCHON_PATHS.health()).then(normalizeHealth); },
      codebases: function () {
        return getJson(ARCHON_PATHS.codebases()).then(function (rows) { return (Array.isArray(rows) ? rows : []).map(normalizeCodebase); });
      },
      workflows: function () { return getJson(ARCHON_PATHS.workflows()).then(normalizeWorkflowList); },
      /** Workflows discovered for one project checkout (bundled ones are always included). */
      workflowsFor: function (cwd) { return getJson(ARCHON_PATHS.workflows(cwd)).then(normalizeWorkflowList); },
      /** One definition, with NORMALIZED nodes; null when the body is not a definition. */
      workflowDefinition: function (name, cwd, source) {
        return getJson(ARCHON_PATHS.workflow(name, cwd, source)).then(normalizeWorkflowDefinition);
      },
      /** Always HTTP 200 for a processed definition: read `valid`, not the status. */
      validateDefinition: function (definition) {
        return postJson(ARCHON_PATHS.workflowValidate(), definitionPayload(definition));
      },
      saveWorkflow: function (name, cwd, source, definition) {
        return putJson(ARCHON_PATHS.workflow(name, cwd, source), definitionPayload(definition));
      },
      deleteWorkflow: function (name, cwd, source) {
        return deleteJson(ARCHON_PATHS.workflow(name, cwd, source));
      },
      runs: function (options) { return getJson(ARCHON_PATHS.runs(options)).then(normalizeRunList); },
      runDetail: function (id) { return getJson(ARCHON_PATHS.run(id)).then(normalizeRunDetail); },
      runArtifacts: function (id) { return getJson(ARCHON_PATHS.runArtifacts(id)).then(normalizeArtifactList); },
      artifactUrl: function (id, path) { return API + ARCHON_PATHS.artifact(id, path); },
      runControl: function (id, verb, text) { return postJson(ARCHON_PATHS.runControl(id, verb), runControlPayload(verb, text)); },
      launchRun: function (name, conversationId, message) {
        return postJson(ARCHON_PATHS.workflowRun(name), launchPayload(conversationId, message));
      },
      conversations: function () {
        return getJson(ARCHON_PATHS.conversations()).then(function (rows) { return (Array.isArray(rows) ? rows : []).map(normalizeConversation); });
      },
      createConversation: function (codebaseId) {
        return postJson(ARCHON_PATHS.conversations(), createConversationPayload(codebaseId));
      },
      messages: function (id, limit) {
        return getJson(ARCHON_PATHS.conversationMessages(id, limit)).then(function (rows) { return (Array.isArray(rows) ? rows : []).map(normalizeMessage); });
      },
      sendMessage: function (id, text) { return postJson(ARCHON_PATHS.conversationMessage(id), sendMessagePayload(text)); },
      conversationStreamUrl: function (id) { return API + ARCHON_PATHS.conversationStream(id); },
      dashboardStreamUrl: function () { return API + ARCHON_PATHS.dashboardStream(); },
      config: function () { return getJson(ARCHON_PATHS.config()).then(normalizeConfig); },
      saveAssistants: function (assistant, assistants) {
        return patchJson(ARCHON_PATHS.configAssistants(), assistantsPayload(assistant, assistants));
      },
      providers: function () { return getJson(ARCHON_PATHS.providers()).then(normalizeProviders); },
      codebaseEnvKeys: function (id) { return getJson(ARCHON_PATHS.codebaseEnv(id)).then(normalizeEnvKeys); },
      setCodebaseEnv: function (id, key, value) { return putJson(ARCHON_PATHS.codebaseEnv(id), envVarPayload(key, value)); },
      deleteCodebaseEnv: function (id, key) { return deleteJson(ARCHON_PATHS.codebaseEnvKey(id, key)); },
      registerCodebase: function (value) { return postJson(ARCHON_PATHS.codebases(), registerCodebasePayload(value)); },
      removeCodebase: function (id) { return deleteJson(ARCHON_PATHS.codebase(id)); },
      /** The dsh host's own probe: relay target, reachability, and the compatibility verdict. */
      hostState: function () {
        return new Promise(function (resolve) {
          try {
            fetch(HOST_STATE, { headers: { accept: "application/json" } })
              .then(function (r) { return r.json(); })
              .then(resolve, function () { resolve(null); });
          } catch (e) {
            resolve(null);
          }
        });
      },
    };

    // ---- tiny shared module store (module-level UI flags only) ------------

    var store = { busy: null }; // busy = { kind, label } while an action runs
    var storeListeners = new Set();
    function writeStore(patch) { Object.assign(store, patch); storeListeners.forEach(function (l) { l(); }); }
    function subscribeStore(l) { storeListeners.add(l); return function () { storeListeners.delete(l); }; }

    // ---- presentational helpers -------------------------------------------

    function statusClass(status) {
      if (status === "running" || status === "pending") return "running";
      if (status === "completed") return "ok";
      if (status === "failed" || status === "cancelled") return "err";
      if (status === "paused") return "warn";
      return "";
    }

    function runOutcome(run) {
      if (run.outcome === "succeeded") return " ✓";
      if (run.outcome === "failed") return " ✗";
      return "";
    }

    /**
     * Archon hands back two timestamp shapes: ISO-8601 with a zone on run rows
     * and SQLite's zone-less "YYYY-MM-DD HH:MM:SS" on run-event rows, which the
     * server writes in UTC. Every timestamp in this bundle is parsed here.
     */
    function parseTime(value) {
      if (!value) return NaN;
      var text = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) text = text.replace(" ", "T") + "Z";
      return Date.parse(text);
    }

    function localTime(value) {
      var t = parseTime(value);
      return Number.isNaN(t) ? "—" : new Date(t).toLocaleString();
    }

    function clockTime(value) {
      var t = parseTime(value);
      return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString();
    }

    function errorText(error) {
      return error && error.message ? error.message : String(error);
    }

    function formatBytes(size) {
      if (typeof size !== "number" || !Number.isFinite(size)) return "";
      if (size < 1024) return size + " B";
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KiB";
      return (size / (1024 * 1024)).toFixed(1) + " MiB";
    }

    function timeAgo(value) {
      var t = parseTime(value);
      if (Number.isNaN(t)) return "";
      var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (s < 5) return "now";
      if (s < 60) return s + "s ago";
      var m = Math.floor(s / 60);
      if (m < 60) return m + "m ago";
      var h = Math.floor(m / 60);
      if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }

    /** Which run controls make sense for a run's status. */
    function controlsForRun(run) {
      var status = run.status;
      if (status === "running" || status === "pending") return ["cancel", "abandon"];
      if (status === "paused") return ["approve", "reject", "resume", "cancel", "abandon"];
      if (status === "failed") return ["resume", "abandon"];
      return [];
    }

    var CONTROL_LABELS = {
      approve: "Approve",
      reject: "Reject",
      resume: "Resume",
      cancel: "Cancel",
      abandon: "Abandon",
    };

    // ---- console view ------------------------------------------------------

    function ArchonConsole() {
      var state = React.useState({
        mode: "console", // "console" | "chat" | "studio"
        studioDirty: false,  // the Studio reports its unsaved state up for the mode guard
        modeArm: "",         // mode a click is armed to switch to, discarding Studio edits
        health: null,        // normalizeHealth view model
        compat: null,        // host compatibility verdict { compatible, reason, tested, ... }
        codebases: null,     // normalizeCodebase[]
        workflows: null,     // { entries, errorCount }
        runs: null,          // normalizeRun[]
        error: "",
        notice: "",
        launching: false,
        launchWorkflow: "",
        launchMessage: "",
        // run detail drill-down: which run's panel is open, and a counter the
        // dashboard SSE bumps so the open panel re-fetches on live progress.
        detailRunId: "",
        detailTick: 0,
        // chat state
        conversations: null,
        activeConvId: "",       // platform conversation id
        messages: [],
        chatError: "",
        sending: false,
        draft: "",
        streaming: false,
        streamText: "",
        chatCodebaseId: "",
      });
      var s = state[0];
      var set = state[1];

      function patch(p) { set(function (prev) { return Object.assign({}, prev, p); }); }

      function loadAll() {
        Promise.all([
          Archon.health().catch(function (e) { return { __error: e }; }),
          Archon.codebases().catch(function (e) { return { __error: e }; }),
          Archon.workflows().catch(function (e) { return { __error: e }; }),
          Archon.runs({ limit: 30 }).catch(function (e) { return { __error: e }; }),
          Archon.hostState(),
        ]).then(function (results) {
          var health = results[0], codebases = results[1], workflows = results[2], runs = results[3], host = results[4];
          var error = "";
          if (health && health.__error) error = "Archon unreachable via relay: " + errorText(health.__error);
          else if (health && health.status !== "ok") error = "Archon health not ok: " + health.status;
          patch({
            health: health && !health.__error ? health : null,
            error: error,
            compat: host && host.compat ? host.compat : null,
            codebases: codebases && !codebases.__error ? codebases : null,
            workflows: workflows && !workflows.__error ? workflows : null,
            runs: runs && !runs.__error ? runs : null,
          });
        });
      }

      function toggleDetail(runId) {
        set(function (prev) {
          return Object.assign({}, prev, { detailRunId: prev.detailRunId === runId ? "" : runId });
        });
      }

      // ---- run control actions --------------------------------------------

      function runControl(run, verb) {
        if (store.busy) return;
        var label = CONTROL_LABELS[verb] || verb;
        var text = verb === "reject" ? "Rejected from dsh-archon console"
          : verb === "approve" ? "Approved from dsh-archon console"
            : "";
        writeStore({ busy: { kind: "run-" + verb, label: label } });
        Archon.runControl(run.id, verb, text)
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300) {
              patch({ notice: label + " requested for " + String(run.id).slice(0, 8) });
            } else {
              patch({ notice: label + " failed: " + (res.error || ("http " + res.__httpStatus)) });
            }
          })
          .catch(function (e) {
            patch({ notice: label + " failed: " + (e && e.message ? e.message : String(e)) });
          })
          .then(function () {
            writeStore({ busy: null });
            setTimeout(loadAll, 600);
          });
      }

      // ---- launch ---------------------------------------------------------

      /**
       * Archon's run endpoint requires a platform conversation to receive the
       * run's messages. Reuse the console's active chat conversation when one
       * is open; otherwise create a web conversation (bound to the chosen or
       * first codebase, like the Chat pane's "New conversation" button).
       */
      function ensureLaunchConversation() {
        if (s.activeConvId) return Promise.resolve(s.activeConvId);
        var codebaseId = s.chatCodebaseId || (Array.isArray(s.codebases) && s.codebases.length ? s.codebases[0].id : undefined);
        return Archon.createConversation(codebaseId).then(function (res) {
          var id = createdConversationId(res);
          if (id) {
            patch({ activeConvId: id });
            return id;
          }
          throw new Error("could not create a conversation for the run" + (res && res.error ? ": " + res.error : ""));
        });
      }

      function launchWorkflow() {
        if (store.busy) return;
        var name = s.launchWorkflow;
        if (!name) { patch({ notice: "Pick a workflow first." }); return; }
        writeStore({ busy: { kind: "launch", label: "Launching" } });
        ensureLaunchConversation()
          .then(function (conversationId) {
            return Archon.launchRun(name, conversationId, s.launchMessage || "Run " + name + " from dsh-archon console");
          })
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300) {
              patch({ notice: "Launched " + name + (res.status ? " (" + res.status + ")" : "") });
            } else {
              patch({ notice: "Launch failed: " + (res.error || ("http " + res.__httpStatus)) });
            }
          })
          .catch(function (e) {
            patch({ notice: "Launch failed: " + (e && e.message ? e.message : String(e)) });
          })
          .then(function () {
            writeStore({ busy: null });
            setTimeout(loadAll, 1200);
          });
      }

      React.useEffect(function () {
        loadAll();
        // Live dashboard: every workflow_status/dag_node frame invalidates the
        // runs + health views (REST stays the source of truth).
        var es;
        try {
          es = new EventSource(Archon.dashboardStreamUrl());
          var timer = null;
          function onEvent() {
            if (timer) return;
            timer = setTimeout(function () {
              timer = null;
              loadAll();
              set(function (prev) {
                return prev.detailRunId ? Object.assign({}, prev, { detailTick: prev.detailTick + 1 }) : prev;
              });
            }, 400);
          }
          SSE_EVENTS.dashboard.forEach(function (type) { es.addEventListener(type, onEvent); });
        } catch (e) {
          // EventSource failure is non-fatal; list views still load via REST.
        }
        return function () { if (es) es.close(); };
        // mount-only; loadAll reads current state via patch only
      }, []);

      // ---- chat helpers ------------------------------------------------------

      function loadConversations() {
        Archon.conversations().catch(function (e) { return { __error: e }; })
          .then(function (convs) {
            patch({ conversations: convs && !convs.__error ? convs : null, chatError: convs && convs.__error ? "conversations unavailable: " + errorText(convs.__error) : "" });
            // Default to the first conversation if none selected.
            set(function (prev) {
              if (prev.activeConvId || !Array.isArray(convs) || convs.length === 0) return prev;
              return Object.assign({}, prev, { activeConvId: convs[0].platformId });
            });
          });
      }

      var chatEsRef = null;

      /** Open the SSE stream for one conversation and append its live events. */
      function openChatStream(convId) {
        if (chatEsRef) { try { chatEsRef.close(); } catch (e) {} chatEsRef = null; }
        if (!convId) return;
        var es;
        try {
          es = new EventSource(Archon.conversationStreamUrl(convId));
        } catch (e) { return; }
        chatEsRef = es;
        es.onmessage = function (raw) {
          var parsed;
          try { parsed = JSON.parse(raw.data); } catch (e) { return; }
          var frame = normalizeConversationFrame(parsed);
          if (frame.type === "text") {
            patch({ streaming: true, streamText: frame.text });
          } else if (frame.type === "tool_call") {
            patch({ streaming: true, streamText: (frame.tool || "tool") + " …" });
          } else if (frame.type === "tool_result") {
            patch({ streamText: "" });
          } else if (frame.type === "conversation_lock") {
            if (!frame.locked) { set(function (prev) { return Object.assign({}, prev, { streaming: false, streamText: "" }); }); refreshMessages(convId); }
          } else if (frame.type === "workflow_status") {
            set(function (prev) {
              var tail = prev.streaming ? "… " + frame.status.toUpperCase() : "";
              return Object.assign({}, prev, { streaming: false, streamText: tail });
            });
            refreshMessages(convId);
          }
        };
        es.onerror = function () { /* EventSource auto-reconnects */ };
      }

      /** Fetch persisted messages for the active conversation. */
      function refreshMessages(convId) {
        if (!convId) return;
        Archon.messages(convId, 100).catch(function (e) { return { __error: e }; })
          .then(function (rows) {
            if (rows && !rows.__error && Array.isArray(rows)) {
              set(function (prev) {
                var streaming = prev.streaming && prev.streamText ? prev.streamText : "";
                var list = rows.slice();
                if (streaming) {
                  var last = list[list.length - 1];
                  if (last && last.role === "assistant") {
                    last.content = last.content + streaming;
                  } else {
                    list.push({ role: "assistant", content: streaming });
                  }
                }
                return Object.assign({}, prev, { messages: list, streaming: false, streamText: "" });
              });
            }
          });
      }

      function selectConversation(convId) {
        patch({ activeConvId: convId, messages: [], streaming: false, streamText: "", chatError: "" });
        openChatStream(convId);
        refreshMessages(convId);
      }

      /** Create a web conversation (optionally on the chosen codebase) and open it. */
      function createConversation() {
        var codebaseId = s.chatCodebaseId || (Array.isArray(s.codebases) && s.codebases.length ? s.codebases[0].id : undefined);
        if (store.busy) return;
        writeStore({ busy: { kind: "chat-create", label: "Creating" } });
        Archon.createConversation(codebaseId)
          .then(function (res) {
            var id = createdConversationId(res);
            if (id) {
              loadConversations();
              selectConversation(id);
              patch({ notice: "Conversation " + id + " created" });
            } else {
              patch({ chatError: "create failed: " + (res && res.error ? res.error : "no id") });
            }
          })
          .catch(function (e) { patch({ chatError: "create failed: " + (e && e.message ? e.message : String(e)) }); })
          .then(function () { writeStore({ busy: null }); });
      }

      function sendMessage() {
        var text = s.draft.trim();
        if (!text || !s.activeConvId || s.sending) return;
        set(function (prev) { return Object.assign({}, prev, { sending: true, messages: prev.messages.concat([{ role: "user", content: text }]), draft: "" }); });
        Archon.sendMessage(s.activeConvId, text)
          .then(function (res) {
            if (res && res.__httpStatus >= 200 && res.__httpStatus < 300) {
              patch({ streaming: true, streamText: "…" });
            } else {
              patch({ chatError: "send failed: " + (res && res.error ? res.error : ("http " + (res && res.__httpStatus))) });
            }
          })
          .catch(function (e) { patch({ chatError: "send failed: " + (e && e.message ? e.message : String(e)) }); })
          .then(function () {
            set(function (prev) { return Object.assign({}, prev, { sending: false }); });
            setTimeout(function () { refreshMessages(s.activeConvId); }, 400);
          });
      }

      /**
       * Switching away from a dirty Studio arms first and switches on the second
       * click: the Studio unmounts on the way out, so its edits are discarded.
       */
      function switchMode(next) {
        if (s.mode === "studio" && next !== "studio" && s.studioDirty && s.modeArm !== next) {
          patch({ modeArm: next });
          return;
        }
        patch({ mode: next, modeArm: "", studioDirty: next === "studio" ? s.studioDirty : false });
      }

      // ---- render -----------------------------------------------------------

      var notice = s.notice
        ? React.createElement("div", { className: "dsha-notice" }, s.notice)
        : null;

      return React.createElement("div", { className: "dsha-view" },
        React.createElement("div", { className: "dsha-header" },
          React.createElement("div", { className: "dsha-title" }, "Archon"),
          React.createElement("div", { className: "dsha-modes" },
            React.createElement("button", { type: "button", className: "dsha-mode" + (s.mode === "console" ? " dsha-mode-active" : ""), onClick: function () { switchMode("console"); } }, s.modeArm === "console" ? "Discard edits?" : "Console"),
            React.createElement("button", { type: "button", className: "dsha-mode" + (s.mode === "chat" ? " dsha-mode-active" : ""), onClick: function () { switchMode("chat"); if (s.mode !== "studio" || !s.studioDirty || s.modeArm === "chat") loadConversations(); } }, s.modeArm === "chat" ? "Discard edits?" : "Chat"),
            React.createElement("button", { type: "button", className: "dsha-mode" + (s.mode === "studio" ? " dsha-mode-active" : ""), onClick: function () { switchMode("studio"); } }, "Studio")),
          React.createElement("div", { className: "dsha-sub" }, s.error
            ? React.createElement("span", { className: "dsha-err" }, s.error)
            : renderHealth(s.health, s.compat))),
        notice,
        s.mode === "studio"
          ? React.createElement(ArchonStudio, { onDirtyChange: function (dirty) { patch({ studioDirty: dirty }); } })
          : s.mode === "chat"
          ? renderChatPane(s, patch, selectConversation, loadConversations, createConversation, sendMessage, openChatStream, refreshMessages)
          : React.createElement("div", { className: "dsha-console" },
            React.createElement("div", { className: "dsha-body" },
              renderLaunchPanel(s, patch, launchWorkflow, store),
              renderSection("Projects", renderCodebases(s.codebases)),
              renderSection("Workflows", renderWorkflows(s.workflows)),
              renderSection("Runs", renderRuns(s.runs, runControl, store, toggleDetail, s.detailRunId))),
            s.detailRunId
              ? React.createElement(RunDetailPanel, {
                key: s.detailRunId,
                runId: s.detailRunId,
                refreshTick: s.detailTick,
                onClose: function () { patch({ detailRunId: "" }); },
              })
              : null));
    }

    // ---- Chat mode -----------------------------------------------------------

    function renderChatPane(s, patch, selectConversation, loadConversations, createConversation, sendMessage) {
      var convs = s.conversations;
      var codebases = s.codebases;
      var active = s.activeConvId;
      var messages = s.messages || [];

      // Conversation selector options.
      var convOptions = [];
      if (Array.isArray(convs)) {
        convs.forEach(function (c) {
          var id = c.platformId;
          var label = (c.title ? c.title : (c.id ? String(c.id).slice(0, 8) : id)) + (c.codebaseId ? "" : " (no project)");
          convOptions.push(React.createElement("option", { key: id, value: id }, label));
        });
      }
      // Codebase options for "new conversation".
      var cbOptions = [];
      if (Array.isArray(codebases)) {
        codebases.forEach(function (c) {
          cbOptions.push(React.createElement("option", { key: c.id, value: c.id }, c.name));
        });
      }

      var bubbles = messages.map(function (m, i) {
        var cls = "dsha-bubble" + (m.role === "assistant" ? " dsha-bubble-assistant" : " dsha-bubble-user");
        return React.createElement("div", { key: i, className: cls }, m.content);
      });
      if (s.streaming && s.streamText) {
        bubbles.push(React.createElement("div", { key: "stream", className: "dsha-bubble dsha-bubble-assistant dsha-stream" }, s.streamText));
      }
      if (bubbles.length === 0) {
        bubbles = React.createElement("div", { className: "dsha-chat-empty" },
          "Pick a conversation on the left (or create one) and start chatting with the Archon routing agent.");
      }

      return React.createElement("div", { className: "dsha-chat" },
        React.createElement("div", { className: "dsha-chat-side" },
          React.createElement("div", { className: "dsha-section-title" }, "Conversations"),
          React.createElement("select", {
            className: "dsha-input",
            value: active,
            disabled: !Array.isArray(convs) || convs.length === 0,
            onChange: function (e) { selectConversation(e.target.value); },
          }, convOptions),
          React.createElement("button", { type: "button", className: "dsha-btn dsha-btn-primary dsha-chat-new", onClick: function () { createConversation(); } },
            store.busy && store.busy.kind === "chat-create" ? "Creating…" : "New conversation"),
          React.createElement("select", {
            className: "dsha-input",
            value: s.chatCodebaseId || (Array.isArray(codebases) && codebases.length ? codebases[0].id : ""),
            disabled: !Array.isArray(codebases) || codebases.length === 0,
            onChange: function (e) { patch({ chatCodebaseId: e.target.value }); },
            title: "Project to bind the new conversation to",
          }, cbOptions.length > 0 ? cbOptions : [React.createElement("option", { key: "", value: "" }, "no projects")]),
          s.chatError ? React.createElement("div", { className: "dsha-err dsha-chat-err" }, s.chatError) : null),
        React.createElement("div", { className: "dsha-chat-main" },
          React.createElement("div", { className: "dsha-chat-log" }, bubbles),
          React.createElement("div", { className: "dsha-composer" },
            React.createElement("input", {
              className: "dsha-input dsha-input-flex",
              type: "text",
              placeholder: active ? "Message the Archon routing agent…" : "Open or create a conversation first",
              value: s.draft,
              disabled: !active || s.sending || store.busy,
              onChange: function (e) { patch({ draft: e.target.value }); },
              onKeyDown: function (e) { if (e.key === "Enter") sendMessage(); },
            }),
            React.createElement("button", {
              type: "button",
              className: "dsha-btn dsha-btn-primary",
              disabled: !active || s.sending || !s.draft.trim() || store.busy,
              onClick: sendMessage,
            }, s.sending ? "Sending…" : "Send"))));
    }

    function renderHealth(h, compat) {
      if (!h) return React.createElement("span", { className: "dsha-muted" }, "loading server state…");
      return React.createElement("span", null,
        "server ", React.createElement("strong", null, h.status),
        h.version ? React.createElement("span", null, " · v" + h.version) : null,
        h.activePlatforms.length
          ? React.createElement("span", null, " · platforms: " + h.activePlatforms.join(", "))
          : null,
        renderCompat(compat));
    }

    /**
     * Inline verdict from the host's compatibility check (package.json
     * `archon`). Silent while compatible or undecided; a warning when the
     * running Archon is outside the tested range.
     */
    function renderCompat(compat) {
      if (!compat || compat.compatible !== false) return null;
      return React.createElement("span", { className: "dsha-warn", title: compat.reason },
        " · untested Archon version (plugin tested with " + compat.tested + ")");
    }

    function renderSection(title, body) {
      return React.createElement("div", { className: "dsha-section" },
        React.createElement("h3", { className: "dsha-section-title" }, title),
        body);
    }

    function renderLaunchPanel(s, patch, launchWorkflow, store) {
      var wf = s.workflows ? s.workflows.entries : [];
      var options = [React.createElement("option", { key: "", value: "" }, "— pick a workflow —")];
      wf.slice(0, 200).forEach(function (entry) {
        options.push(React.createElement("option", { key: entry.name, value: entry.name }, entry.name + " [" + entry.source + "]"));
      });
      var busy = store.busy && store.busy.kind === "launch";
      return React.createElement("div", { className: "dsha-launch" },
        React.createElement("select", {
          className: "dsha-input",
          value: s.launchWorkflow,
          disabled: busy,
          onChange: function (e) { patch({ launchWorkflow: e.target.value }); },
        }, options),
        React.createElement("input", {
          className: "dsha-input dsha-input-flex",
          type: "text",
          placeholder: "Message / task for the run (optional)",
          value: s.launchMessage,
          disabled: busy,
          onChange: function (e) { patch({ launchMessage: e.target.value }); },
          onKeyDown: function (e) { if (e.key === "Enter") launchWorkflow(); },
        }),
        React.createElement("button", {
          type: "button",
          className: "dsha-btn dsha-btn-primary",
          disabled: busy || !s.launchWorkflow,
          onClick: launchWorkflow,
        }, busy ? "Launching…" : "Run workflow"));
    }

    function renderCodebases(cb) {
      if (cb === null) return React.createElement("p", { className: "dsha-muted" }, "No response.");
      if (cb.length === 0) return React.createElement("p", { className: "dsha-muted" }, "No registered projects. Register one in Archon (CLI: archon workflow run inside a repo; API: POST /api/codebases).");
      return React.createElement("ul", { className: "dsha-list" },
        cb.map(function (c) {
          return React.createElement("li", { key: c.id },
            React.createElement("span", { className: "dsha-strong" }, c.name),
            c.repositoryUrl ? React.createElement("span", { className: "dsha-muted" }, " · " + c.repositoryUrl) : null,
            React.createElement("span", { className: "dsha-muted" }, " · " + (c.kind || "repo")));
        }));
    }

    function renderWorkflows(wf) {
      if (wf === null) return React.createElement("p", { className: "dsha-muted" }, "No response.");
      var list = wf.entries;
      if (list.length === 0) return React.createElement("p", { className: "dsha-muted" }, "No workflows discovered.");
      return React.createElement("div", null,
        React.createElement("ul", { className: "dsha-list dsha-wf" },
          list.slice(0, 40).map(function (entry) {
            return React.createElement("li", { key: entry.name },
              React.createElement("span", { className: "dsha-strong" }, entry.name),
              React.createElement("span", { className: "dsha-src" }, " [" + entry.source + "]"),
              entry.description ? React.createElement("div", { className: "dsha-desc" }, entry.description) : null);
          })),
        list.length > 40 ? React.createElement("p", { className: "dsha-muted" }, "… and " + (list.length - 40) + " more") : null,
        wf.errorCount ? React.createElement("p", { className: "dsha-err" }, "Discovery warnings: " + wf.errorCount) : null);
    }

    function renderRuns(runs, runControl, store, toggleDetail, detailRunId) {
      if (runs === null) return React.createElement("p", { className: "dsha-muted" }, "No response.");
      var list = runs;
      if (list.length === 0) return React.createElement("p", { className: "dsha-muted" }, "No runs yet. Use the launch panel above; live progress will appear here.");
      return React.createElement("table", { className: "dsha-runs" },
        React.createElement("thead", null,
          React.createElement("tr", null,
            React.createElement("th", null, "Workflow"),
            React.createElement("th", null, "Status"),
            React.createElement("th", null, "When"),
            React.createElement("th", null, "Id"),
            React.createElement("th", null, "Actions"))),
        React.createElement("tbody", null,
          list.map(function (run) {
            var controls = controlsForRun(run);
            var anyBusy = store.busy !== null;
            return React.createElement("tr", { key: run.id },
              React.createElement("td", { className: "dsha-strong" }, run.workflow || "?"),
              React.createElement("td", null,
                React.createElement("span", { className: "dsha-status " + statusClass(run.status) }, run.status + (run.outcome ? runOutcome(run) : ""))),
              React.createElement("td", { className: "dsha-muted" }, timeAgo(run.lastActivityAt || run.startedAt)),
              React.createElement("td", { className: "dsha-mono" }, String(run.id).slice(0, 8)),
              React.createElement("td", null,
                React.createElement("button", {
                  type: "button",
                  className: "dsha-btn dsha-btn-small",
                  "aria-expanded": run.id === detailRunId,
                  onClick: function () { toggleDetail(run.id); },
                }, "Details"),
                controls.map(function (verb) {
                  return React.createElement("button", {
                    key: verb,
                    type: "button",
                    className: "dsha-btn dsha-btn-small" + (verb === "reject" || verb === "cancel" || verb === "abandon" ? " dsha-btn-danger" : ""),
                    disabled: anyBusy,
                    onClick: function () { runControl(run, verb); },
                  }, CONTROL_LABELS[verb]);
                })));
          })));
    }

    // ---- run detail drill-down + artifacts --------------------------------
    // Archon.runDetail -> { run, events[] }, Archon.runArtifacts -> [{ path,
    // size, modifiedAt }] | null; one artifact's bytes come from
    // Archon.artifactUrl (the wildcard content route).

    /** A long run can log thousands of events, so only the tail is rendered. */
    var TIMELINE_LIMIT = 300;
    var EVENT_PAYLOAD_CHARS = 240;
    /** Largest artifact fetched for an inline preview. */
    var PREVIEW_MAX_BYTES = 64 * 1024;

    function artifactUrl(runId, path) {
      return Archon.artifactUrl(runId, path);
    }

    // Archon labels every artifact `text/plain`, so the content type cannot tell
    // a UTF-8 file from binary bytes decoded with replacement characters. The
    // decoded body is the only evidence available.
    var NON_TEXT = /[\u0000-\u0008\u000E-\u001F\uFFFD]/g;

    function looksTextual(text) {
      if (!text) return true;
      var hits = text.match(NON_TEXT);
      return !hits || hits.length / text.length < 0.01;
    }

    function eventSummary(event) {
      var data = event.data;
      if (data === null || data === undefined) return "";
      var text;
      try {
        text = typeof data === "string" ? data : JSON.stringify(data);
      } catch (e) {
        return "";
      }
      if (typeof text !== "string") return "";
      return text.length > EVENT_PAYLOAD_CHARS ? text.slice(0, EVENT_PAYLOAD_CHARS) + " …" : text;
    }

    function detailRow(label, value) {
      return React.createElement("div", { className: "dsha-detail-row" },
        React.createElement("span", { className: "dsha-detail-label" }, label),
        React.createElement("span", { className: "dsha-detail-value" }, value));
    }

    function renderRunHeader(run) {
      return React.createElement("div", { className: "dsha-detail-head" },
        React.createElement("div", { className: "dsha-detail-name" },
          React.createElement("span", { className: "dsha-strong" }, run.workflow || "?"),
          React.createElement("span", { className: "dsha-status " + statusClass(run.status) },
            String(run.status) + runOutcome(run))),
        detailRow("Run id", React.createElement("span", { className: "dsha-mono" }, String(run.id))),
        detailRow("Started", localTime(run.startedAt)),
        detailRow("Completed", run.completedAt ? localTime(run.completedAt) : "—"),
        detailRow("Last activity", timeAgo(run.lastActivityAt || run.startedAt) || "—"),
        run.message
          ? detailRow("Message", React.createElement("span", { className: "dsha-detail-msg" }, run.message))
          : null);
    }

    function renderTimeline(events) {
      var list = Array.isArray(events) ? events : [];
      var hidden = Math.max(0, list.length - TIMELINE_LIMIT);
      var rows = list.slice(hidden).map(function (event) {
        var summary = eventSummary(event);
        return React.createElement("li", { key: event.id },
          React.createElement("span", { className: "dsha-timeline-time" }, clockTime(event.at)),
          React.createElement("span", { className: "dsha-timeline-type" }, event.type),
          event.step ? React.createElement("span", { className: "dsha-timeline-step" }, event.step) : null,
          summary ? React.createElement("div", { className: "dsha-timeline-data" }, summary) : null);
      });
      if (hidden > 0) {
        rows.unshift(React.createElement("li", { key: "hidden", className: "dsha-muted" }, hidden + " earlier events hidden"));
      }
      return React.createElement("div", { className: "dsha-detail-section" },
        React.createElement("h4", { className: "dsha-section-title" }, "Timeline (" + list.length + ")"),
        list.length === 0
          ? React.createElement("p", { className: "dsha-muted" }, "No events recorded for this run.")
          : React.createElement("ol", { className: "dsha-timeline" }, rows));
    }

    function renderPreview(runId, file, p) {
      if (p.previewLoading) {
        return React.createElement("p", { className: "dsha-preview-note" }, "Loading preview…");
      }
      if (p.previewNote) {
        return React.createElement("p", { className: "dsha-preview-note" },
          p.previewNote + " ",
          React.createElement("a", {
            className: "dsha-link",
            href: artifactUrl(runId, file.path),
            target: "_blank",
            rel: "noopener noreferrer",
          }, "Open raw"));
      }
      return React.createElement("pre", { className: "dsha-code dsha-preview" }, p.previewText);
    }

    function renderArtifacts(runId, p, togglePreview) {
      var files = p.artifacts;
      var body;
      if (p.artifactsError) {
        body = React.createElement("p", { className: "dsha-err" }, p.artifactsError);
      } else if (!files || files.length === 0) {
        body = React.createElement("p", { className: "dsha-muted" }, "No artifacts written by this run.");
      } else {
        body = React.createElement("ul", { className: "dsha-artifacts" },
          files.map(function (file) {
            var open = p.previewPath === file.path;
            return React.createElement("li", { key: file.path },
              React.createElement("button", {
                type: "button",
                className: "dsha-artifact" + (open ? " dsha-artifact-open" : ""),
                "aria-expanded": open,
                onClick: function () { togglePreview(file); },
              },
                React.createElement("span", { className: "dsha-artifact-path" }, file.path),
                React.createElement("span", { className: "dsha-muted" },
                  formatBytes(file.size) + " · " + (timeAgo(file.modifiedAt) || "—"))),
              open ? renderPreview(runId, file, p) : null);
          }));
      }
      return React.createElement("div", { className: "dsha-detail-section" },
        React.createElement("h4", { className: "dsha-section-title" }, "Artifacts" + (!p.artifactsError && files ? " (" + files.length + ")" : "")),
        body);
    }

    /**
     * Side panel for one run. The caller keys it by run id, so switching rows
     * remounts it; `refreshTick` changes whenever dashboard SSE reports live
     * progress, which re-fetches the run and its artifact listing in place.
     */
    function RunDetailPanel(props) {
      var runId = props.runId;
      var state = React.useState({
        loading: true,
        error: "",
        run: null,
        events: [],
        artifacts: null,
        artifactsError: "",
        previewPath: "",
        previewText: "",
        previewNote: "",
        previewLoading: false,
      });
      var p = state[0];
      var set = state[1];
      function patch(x) { set(function (prev) { return Object.assign({}, prev, x); }); }

      React.useEffect(function () {
        var live = true;
        Promise.all([
          Archon.runDetail(runId).catch(function (e) { return { __error: e }; }),
          Archon.runArtifacts(runId).catch(function (e) { return { __error: e }; }),
        ]).then(function (results) {
          if (!live) return;
          var detail = results[0];
          var listing = results[1];
          var detailIsError = detail && detail.__error;
          var listingIsError = listing && !Array.isArray(listing) && listing.__error;
          var listingIsValid = Array.isArray(listing);
          patch({
            loading: false,
            error: detailIsError ? "Run detail unavailable: " + errorText(detailIsError) : "",
            run: detailIsError ? null : detail.run,
            events: detailIsError ? [] : detail.events,
            artifacts: listingIsValid ? listing : null,
            artifactsError: listingIsError
              ? "Artifacts unavailable: " + errorText(listingIsError) + "."
              : (!listingIsValid ? "Artifacts unavailable: invalid response from the server." : ""),
          });
        });
        return function () { live = false; };
      }, [runId, props.refreshTick]);

      function togglePreview(file) {
        if (p.previewPath === file.path) {
          patch({ previewPath: "", previewText: "", previewNote: "", previewLoading: false });
          return;
        }
        if (file.size > PREVIEW_MAX_BYTES) {
          patch({
            previewPath: file.path,
            previewText: "",
            previewLoading: false,
            previewNote: "Too large to preview inline (" + formatBytes(file.size) + ").",
          });
          return;
        }
        patch({ previewPath: file.path, previewText: "", previewNote: "", previewLoading: true });
        fetch(artifactUrl(runId, file.path), { headers: { accept: "text/plain" } })
          .then(function (r) {
            if (!r.ok) return { note: "Preview failed: http " + r.status + "." };
            return r.text().then(function (text) {
              return looksTextual(text) ? { text: text } : { note: "Not a text file." };
            });
          })
          .catch(function (e) { return { note: "Preview failed: " + errorText(e) + "." }; })
          .then(function (result) {
            set(function (prev) {
              if (prev.previewPath !== file.path) return prev; // a newer click won
              return Object.assign({}, prev, {
                previewLoading: false,
                previewText: result.text || "",
                previewNote: result.note || "",
              });
            });
          });
      }

      var body;
      if (p.loading) {
        body = React.createElement("p", { className: "dsha-muted" }, "Loading run…");
      } else if (p.error) {
        body = React.createElement("p", { className: "dsha-err" }, p.error);
      } else if (!p.run) {
        body = React.createElement("p", { className: "dsha-muted" }, "No run detail returned.");
      } else {
        body = React.createElement("div", null,
          renderRunHeader(p.run),
          renderTimeline(p.events),
          renderArtifacts(runId, p, togglePreview));
      }

      return React.createElement("aside", { className: "dsha-detail", "aria-label": "Run detail" },
        React.createElement("div", { className: "dsha-detail-top" },
          React.createElement("h3", { className: "dsha-section-title" }, "Run detail"),
          React.createElement("button", {
            type: "button",
            className: "dsha-btn dsha-btn-small",
            onClick: props.onClose,
          }, "Close")),
        body);
    }

    // ---- Workflow Studio (third console mode) -----------------------------
    // Author Archon workflow definitions as a node graph: pick a project, open a
    // discovered workflow, edit it on the canvas, validate, save. Every pure
    // transform (import/export, validation, YAML, layout, model edits) lives in
    // the embedded studio-core block above; this half is state, fetches, and
    // rendering. Bundled workflows open read-only with Save-as; the save order
    // is always client validate -> POST /workflows/validate -> PUT.

    /** The write scope + cwd a save uses, or an explanation of why it cannot. */
    function studioSaveScope(s, source) {
      var target = saveTargetFor(source);
      var cwd = studioCwd(s);
      if (target === "project" && !cwd) return { ok: false, reason: "Pick a project first — a project workflow is written inside its checkout." };
      return { ok: true, target: target, cwd: target === "global" ? "" : cwd };
    }

    /** The selected project's checkout path, or "" when none is selected. */
    function studioCwd(s) {
      var projects = Array.isArray(s.projects) ? s.projects : [];
      for (var i = 0; i < projects.length; i++) {
        if (projects[i].id === s.projectId) return projects[i].defaultCwd || "";
      }
      return "";
    }

    /**
     * Human text for a failed write. postJson/putJson resolve error envelopes
     * for non-2xx HTTP responses, but the underlying fetch still rejects on
     * network failure — every write chain catches that into `{ __error }`
     * before this runs, so both shapes land here.
     */
    function studioWriteError(res) {
      if (!res) return "no response";
      if (res.__error) return errorText(res.__error);
      if (res.error) return res.detail ? res.error + ": " + res.detail : res.error;
      return "http " + res.__httpStatus;
    }

    /** A fresh id-keyed map with no Object.prototype (node ids like `constructor`). */
    function newIdMap() {
      return Object.create(null);
    }

    /** Copy an id-keyed map into a fresh null-prototype one. */
    function copyIdMap(map) {
      var out = Object.create(null);
      var keys = Object.keys(map || {});
      for (var i = 0; i < keys.length; i++) out[keys[i]] = map[keys[i]];
      return out;
    }

    /** Positions for every node, recomputed wholesale when any are missing. */
    function studioPositions(s, edges) {
      var nodes = s.model && Array.isArray(s.model.nodes) ? s.model.nodes : [];
      var positions = s.positions || {};
      for (var i = 0; i < nodes.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(positions, nodes[i].id)) return layoutGraph(nodes, edges);
      }
      return positions;
    }

    function ArchonStudio(props) {
      var state = React.useState({
        screen: "picker",       // "picker" | "editor"
        projects: null,         // normalizeCodebase[]
        projectId: "",
        wfList: null,           // normalizeWorkflowList view model
        wfError: "",
        open: null,             // { name, source, filename, isNew }
        model: null,            // studio-core model
        importIssues: [],
        clientIssues: [],
        serverIssues: [],
        dirty: false,
        busy: "",               // "open" | "save" | "validate" | "rename" | "delete"
        selection: null,        // { kind: "node" | "edge", id, source?, target? }
        positions: newIdMap(),
        zoom: 1,
        pendingConnect: "",     // id of the node whose ⊕ port is armed
        showYaml: false,
        nameMode: "",           // "" | "new" | "rename" | "saveas"
        nameDraft: "",
        nameError: "",
        armDelete: false,
        armBack: false,
        notice: "",
      });
      var s = state[0];
      var set = state[1];

      function patch(p) { set(function (prev) { return Object.assign({}, prev, p); }); }

      /** Every model mutation goes through here: one place sets the dirty flag. */
      function commit(model, extra) {
        patch(Object.assign({ model: model, dirty: true }, extra || {}));
        if (props && props.onDirtyChange) props.onDirtyChange(true);
      }

      function clearDirty(extra) {
        patch(Object.assign({ dirty: false }, extra || {}));
        if (props && props.onDirtyChange) props.onDirtyChange(false);
      }

      // ---- loading ---------------------------------------------------------

      React.useEffect(function () {
        var live = true;
        Archon.codebases().catch(function (e) { return { __error: e }; }).then(function (rows) {
          if (!live) return;
          if (!rows || rows.__error) {
            patch({ projects: [], wfError: "Projects unavailable: " + errorText(rows && rows.__error) + "." });
            return;
          }
          patch({ projects: rows, projectId: rows.length ? rows[0].id : "" });
        });
        return function () { live = false; };
      }, []);

      React.useEffect(function () {
        var live = true;
        Archon.workflowsFor(studioCwd(s)).catch(function (e) { return { __error: e }; }).then(function (list) {
          if (!live) return;
          if (!list || list.__error) {
            patch({ wfList: null, wfError: "Workflows unavailable: " + errorText(list && list.__error) + "." });
            return;
          }
          patch({ wfList: list, wfError: "" });
        });
        return function () { live = false; };
      }, [s.projectId, s.projects]);

      /** Re-read the workflow list for the current project (after a write). */
      function refreshList() {
        return Archon.workflowsFor(studioCwd(s)).catch(function (e) { return { __error: e }; }).then(function (list) {
          if (list && !list.__error) patch({ wfList: list });
          return list;
        });
      }

      /** The names already taken in this project (the client-side collision guard). */
      function existingNames() {
        var entries = s.wfList ? s.wfList.entries : [];
        return entries.map(function (entry) { return entry.name; });
      }

      /**
       * The names already owned by THIS project (source === "project"). Save-as
       * must refuse to overwrite one of these silently; bundled names are not in
       * the set, so saving a bundled workflow back under its own name still works
       * as a project override.
       */
      function projectNames() {
        var entries = s.wfList ? s.wfList.entries : [];
        return entries.filter(function (entry) { return entry.source === "project"; })
          .map(function (entry) { return entry.name; });
      }

      // ---- opening ---------------------------------------------------------

      function seedEditor(model, issues, open) {
        var edges = edgesFromModel(model);
        return {
          screen: "editor",
          open: open,
          model: model,
          importIssues: issues,
          clientIssues: [],
          serverIssues: [],
          positions: layoutGraph(model.nodes, edges),
          zoom: 1,
          selection: null,
          pendingConnect: "",
          showYaml: false,
          busy: "",
          notice: "",
          nameMode: "",
          nameDraft: "",
          nameError: "",
          armDelete: false,
          armBack: false,
        };
      }

      function openWorkflow(entry) {
        var source = entry.source;
        var cwd = source === "bundled" ? "" : studioCwd(s);
        patch({ busy: "open", notice: "" });
        Archon.workflowDefinition(entry.name, cwd, source)
          .catch(function (e) { return { __error: e }; })
          .then(function (res) {
            // A 2xx body that is not a definition envelope (normalizer contract):
            // report the drift explicitly, never the literal word "null".
            if (res === null) {
              patch({
                busy: "",
                notice: "Could not open " + entry.name + ": the server returned an unexpected or empty response (an Archon version change may have altered the workflow-definition format).",
              });
              return;
            }
            if (res.__error) {
              var status = res.__error.__httpStatus;
              patch({
                busy: "",
                notice: status === 404
                  ? "Could not open " + entry.name + ": not found. A workflow stored in a subdirectory of .archon/workflows cannot be opened by name, and one deleted out from under the list reports the same — refresh the list and try again."
                  : "Could not open " + entry.name + ": " + errorText(res.__error) + ".",
              });
              return;
            }
            var imported = importDefinition(res.workflow);
            patch(seedEditor(imported.model, imported.issues, {
              name: entry.name,
              source: res.source || source,
              filename: res.filename,
              isNew: false,
            }));
            if (props && props.onDirtyChange) props.onDirtyChange(false);
          });
      }

      function createWorkflow(name) {
        var guard = planRename("", name, existingNames());
        if (!guard.ok) {
          patch({ nameError: renameReasonMessage(guard.reason, name) });
          return;
        }
        var imported = importDefinition(newWorkflowSeed(name));
        patch(Object.assign(seedEditor(imported.model, imported.issues, {
          name: name,
          source: "project",
          filename: name + ".yaml",
          isNew: true,
        }), { dirty: true }));
        if (props && props.onDirtyChange) props.onDirtyChange(true);
      }

      function backToPicker() {
        if (s.dirty && !s.armBack) { patch({ armBack: true }); return; }
        patch({
          screen: "picker", open: null, model: null, dirty: false, armBack: false, armDelete: false,
          importIssues: [], clientIssues: [], serverIssues: [], selection: null, pendingConnect: "",
          nameMode: "", nameDraft: "", nameError: "", notice: "", showYaml: false,
        });
        if (props && props.onDirtyChange) props.onDirtyChange(false);
      }

      // ---- validate and save ----------------------------------------------

      /** The authoring definition for the current model, filed under `name`. */
      function definitionFor(name) {
        var definition = exportDefinition(s.model);
        definition.name = name;
        return definition;
      }

      function runValidation() {
        var name = s.open ? s.open.name : "";
        var client = validateModel(Object.assign({}, s.model, { name: name }));
        patch({ clientIssues: client, busy: "validate", notice: "" });
        Archon.validateDefinition(definitionFor(name))
          .catch(function (e) { return { __error: e }; })
          .then(function (res) {
            if (res && res.valid === true) {
              patch({ busy: "", serverIssues: [], notice: "The server accepted this definition." });
              return;
            }
            if (!res || res.__error || res.__httpStatus < 200 || res.__httpStatus >= 300) {
              patch({ busy: "", serverIssues: serverIssues([studioWriteError(res)]), notice: "" });
              return;
            }
            patch({ busy: "", serverIssues: serverIssues(res.errors), notice: "" });
          });
      }

      /**
       * Save order, always: client validation (blocks before any network call),
       * then POST /workflows/validate, then PUT. `definition.name` is forced to
       * the filename the workflow is stored under.
       */
      function saveWorkflow(name, source) {
        var scope = studioSaveScope(s, source);
        if (!scope.ok) { patch({ notice: scope.reason }); return; }
        // Save-as collision guard: copying a read-only (bundled) workflow into
        // the project must not silently overwrite a project workflow that
        // already exists there. In-place Save of the open project workflow and
        // New/New-first-save are not Save-as writes and are never blocked (a
        // New name was already collision-checked at createWorkflow).
        if (source === "project" && s.open && s.open.source === "bundled") {
          var saveAsGuard = planRename("", name, projectNames());
          if (!saveAsGuard.ok) { patch({ nameError: renameReasonMessage(saveAsGuard.reason, name) }); return; }
        }
        var client = validateModel(Object.assign({}, s.model, { name: name }));
        var blocking = blockingIssues(client);
        if (blocking.length) {
          patch({
            clientIssues: client,
            notice: "Cannot save: fix " + blocking.length + " blocking error" + (blocking.length === 1 ? "" : "s") + " first.",
          });
          return;
        }
        var definition = definitionFor(name);
        patch({ clientIssues: client, busy: "save", notice: "" });
        Archon.validateDefinition(definition)
          .catch(function (e) { return { __error: e }; })
          .then(function (res) {
            if (!res || res.valid !== true) {
              patch({
                busy: "",
                serverIssues: res && !res.__error && res.__httpStatus >= 200 && res.__httpStatus < 300
                  ? serverIssues(res.errors)
                  : serverIssues([studioWriteError(res)]),
                notice: res && res.__error
                  ? "Save failed: " + studioWriteError(res) + "."
                  : "Not saved — the server rejected the definition.",
              });
              return;
            }
            Archon.saveWorkflow(name, scope.cwd, scope.target, definition)
              .catch(function (e) { return { __error: e }; })
              .then(function (write) {
                if (!write || write.__error || write.__httpStatus < 200 || write.__httpStatus >= 300) {
                  patch({ busy: "", notice: "Save failed: " + studioWriteError(write) + "." });
                  return;
                }
                var open = {
                  name: name,
                  source: write.source || scope.target,
                  filename: write.filename || (name + ".yaml"),
                  isNew: false,
                };
                clearDirty({ busy: "", serverIssues: [], open: open, nameMode: "", nameDraft: "", nameError: "", notice: "Saved " + name + "." });
                refreshList();
                reopenSaved(open);
              });
          });
      }

      /** Re-read what the server now holds, so the editor shows the stored form. */
      function reopenSaved(open) {
        var cwd = open.source === "global" ? "" : studioCwd(s);
        Archon.workflowDefinition(open.name, cwd, open.source)
          .catch(function (e) { return { __error: e }; })
          .then(function (res) {
            if (!res || res.__error) return;
            var imported = importDefinition(res.workflow);
            set(function (prev) {
              if (!prev.open || prev.open.name !== open.name || prev.dirty) return prev; // a newer edit won
              return Object.assign({}, prev, {
                model: imported.model,
                importIssues: imported.issues,
                positions: layoutGraph(imported.model.nodes, edgesFromModel(imported.model)),
                selection: null,
              });
            });
          });
      }

      function renameWorkflow(to) {
        var from = s.open.name;
        var guard = planRename(from, to, existingNames());
        if (!guard.ok) { patch({ nameError: renameReasonMessage(guard.reason, to) }); return; }
        var scope = studioSaveScope(s, s.open.source);
        if (!scope.ok) { patch({ nameError: scope.reason }); return; }
        var client = validateModel(Object.assign({}, s.model, { name: to }));
        if (blockingIssues(client).length) {
          patch({ clientIssues: client, nameError: "Fix the blocking errors before renaming." });
          return;
        }
        patch({ busy: "rename", nameError: "" });
        // New name first, old name second: a failed delete leaves a duplicate,
        // never a lost workflow.
        Archon.saveWorkflow(to, scope.cwd, scope.target, definitionFor(to))
          .catch(function (e) { return { __error: e }; })
          .then(function (write) {
            if (!write || write.__error || write.__httpStatus < 200 || write.__httpStatus >= 300) {
              patch({ busy: "", nameError: "Rename failed: " + studioWriteError(write) + "." });
              return;
            }
            // The PUT of the new name already succeeded: a rejected delete must
            // still land in the duplicate-not-loss notice below, so it is caught
            // into the same envelope shape the non-2xx branch reads.
            Archon.deleteWorkflow(from, scope.cwd, scope.target)
              .catch(function (e) { return { __error: e }; })
              .then(function (removed) {
                var failed = !removed || removed.__error || removed.__httpStatus < 200 || removed.__httpStatus >= 300;
                clearDirty({
                  busy: "",
                  open: { name: to, source: write.source || scope.target, filename: write.filename || (to + ".yaml"), isNew: false },
                  nameMode: "",
                  nameDraft: "",
                  nameError: "",
                  serverIssues: [],
                  notice: failed
                    ? "Renamed to " + to + ", but removing " + from + " failed — delete it manually."
                    : "Renamed to " + to + ".",
                });
                refreshList();
              });
          });
      }

      function deleteWorkflow() {
        if (!s.armDelete) { patch({ armDelete: true }); return; }
        var scope = studioSaveScope(s, s.open.source);
        if (!scope.ok) { patch({ armDelete: false, notice: scope.reason }); return; }
        var name = s.open.name;
        patch({ busy: "delete" });
        Archon.deleteWorkflow(name, scope.cwd, scope.target)
          .catch(function (e) { return { __error: e }; })
          .then(function (res) {
            if (!res || res.__error || res.__httpStatus < 200 || res.__httpStatus >= 300) {
              patch({ busy: "", armDelete: false, notice: "Delete failed: " + studioWriteError(res) + "." });
              return;
            }
            clearDirty({
              screen: "picker", open: null, model: null, busy: "", armDelete: false,
              importIssues: [], clientIssues: [], serverIssues: [], selection: null,
              notice: "Deleted " + name + ".",
            });
            refreshList();
          });
      }

      // ---- canvas + inspector edits ---------------------------------------

      function addFromPalette(variant) {
        var added = addNode(s.model, variant);
        var positions = copyIdMap(s.positions);
        var lowest = 0;
        Object.keys(positions).forEach(function (id) {
          if (positions[id] && positions[id].y > lowest) lowest = positions[id].y;
        });
        positions[added.node.id] = { x: 0, y: Object.keys(positions).length ? lowest + NODE_H + 80 : 0 };
        commit(added.model, { positions: positions, selection: { kind: "node", id: added.node.id }, pendingConnect: "" });
      }

      function selectNode(id) {
        if (!isReadOnlySource(s.open && s.open.source) && s.pendingConnect && s.pendingConnect !== id) {
          var connected = connectNodes(s.model, s.pendingConnect, id);
          if (connected !== s.model) {
            commit(connected, { pendingConnect: "", selection: { kind: "node", id: id } });
            return;
          }
          patch({ pendingConnect: "", selection: { kind: "node", id: id } });
          return;
        }
        patch({ selection: { kind: "node", id: id }, pendingConnect: "" });
      }

      function deleteSelection() {
        if (!s.selection) return;
        if (s.selection.kind === "node") {
          var positions = copyIdMap(s.positions);
          delete positions[s.selection.id];
          commit(removeNode(s.model, s.selection.id), { positions: positions, selection: null });
          return;
        }
        commit(disconnectNodes(s.model, s.selection.source, s.selection.target), { selection: null });
      }

      function startDrag(id, event) {
        if (!event || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
        var start = Object.prototype.hasOwnProperty.call(s.positions, id)
          ? s.positions[id]
          : { x: 0, y: 0 };
        var originX = event.clientX;
        var originY = event.clientY;
        var zoom = s.zoom || 1;
        function move(moveEvent) {
          var next = {
            x: Math.max(0, start.x + (moveEvent.clientX - originX) / zoom),
            y: Math.max(0, start.y + (moveEvent.clientY - originY) / zoom),
          };
          set(function (prev) {
            var positions = copyIdMap(prev.positions);
            positions[id] = next;
            return Object.assign({}, prev, { positions: positions });
          });
        }
        function stop() {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
      }

      /** Rename a node in place: rewrites references, positions and selection. */
      function renameNodeId(from, to) {
        var next = String(to || "").trim();
        if (!next || next === from) return;
        if (findNodeIndex(s.model, next) !== -1) {
          patch({ notice: "A node called '" + next + "' already exists." });
          return;
        }
        var positions = copyIdMap(s.positions);
        positions[next] = positions[from];
        delete positions[from];
        commit(renameNode(s.model, from, next), {
          positions: positions,
          selection: { kind: "node", id: next },
          notice: "",
        });
      }

      function editBase(id, key, value) { commit(setBaseField(s.model, id, key, value)); }
      function editData(id, path, value) { commit(setDataField(s.model, id, path, value)); }

      /**
       * Switch a loop between its prompt and command sources. Exactly one may be
       * present, so this clears both and seeds the chosen one — and it goes
       * through `commit`, so the dirty flag and the console's dirty guard arm
       * exactly like every other inspector edit.
       */
      function editLoopSource(id, mode) {
        var cleared = setDataField(setDataField(s.model, id, ["loop", "prompt"], undefined), id, ["loop", "command"], undefined);
        commit(setDataField(cleared, id, ["loop", mode], ""));
      }

      // ---- unload guard ----------------------------------------------------

      React.useEffect(function () {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        if (!s.dirty) return undefined;
        function onBeforeUnload(e) { e.preventDefault(); e.returnValue = ""; }
        window.addEventListener("beforeunload", onBeforeUnload);
        return function () { window.removeEventListener("beforeunload", onBeforeUnload); };
      }, [s.dirty]);

      // Escape disarms a pending connection (clicking blank canvas does too).
      React.useEffect(function () {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        if (!s.pendingConnect) return undefined;
        function onKeyDown(e) { if (e && e.key === "Escape") patch({ pendingConnect: "" }); }
        window.addEventListener("keydown", onKeyDown);
        return function () { window.removeEventListener("keydown", onKeyDown); };
      }, [s.pendingConnect]);

      // ---- render ----------------------------------------------------------

      var helpers = {
        patch: patch,
        openWorkflow: openWorkflow,
        createWorkflow: createWorkflow,
        backToPicker: backToPicker,
        runValidation: runValidation,
        saveWorkflow: saveWorkflow,
        renameWorkflow: renameWorkflow,
        deleteWorkflow: deleteWorkflow,
        addFromPalette: addFromPalette,
        selectNode: selectNode,
        deleteSelection: deleteSelection,
        startDrag: startDrag,
        renameNodeId: renameNodeId,
        editBase: editBase,
        editData: editData,
        editLoopSource: editLoopSource,
      };

      return React.createElement("div", { className: "dsha-studio" },
        s.screen === "picker" ? renderStudioPicker(s, helpers) : renderStudioEditor(s, helpers));
    }

    // ---- Studio: picker ------------------------------------------------------

    function renderStudioPicker(s, h) {
      var projects = Array.isArray(s.projects) ? s.projects : [];
      var options = projects.map(function (project) {
        return React.createElement("option", { key: project.id, value: project.id }, project.name);
      });
      if (!options.length) options = [React.createElement("option", { key: "", value: "" }, "no projects registered")];

      var entries = s.wfList ? s.wfList.entries : [];
      var rows = entries.map(function (entry) {
        return React.createElement("li", { key: entry.source + ":" + entry.name, className: "dsha-studio-row" },
          React.createElement("span", { className: "dsha-strong" }, entry.name),
          React.createElement("span", { className: "dsha-badge-src" }, entry.source),
          entry.description ? React.createElement("span", { className: "dsha-muted dsha-studio-rowdesc" }, entry.description) : null,
          React.createElement("button", {
            type: "button",
            className: "dsha-btn dsha-btn-small",
            disabled: s.busy === "open",
            onClick: function () { h.openWorkflow(entry); },
          }, entry.source === "bundled" ? "View" : "Open"));
      });

      return React.createElement("div", { className: "dsha-studio-picker" },
        React.createElement("div", { className: "dsha-studio-pickbar" },
          React.createElement("label", { className: "dsha-field" },
            React.createElement("span", { className: "dsha-field-label" }, "Project"),
            React.createElement("select", {
              className: "dsha-input",
              value: s.projectId,
              disabled: projects.length === 0,
              onChange: function (e) { h.patch({ projectId: e.target.value, wfList: null, wfError: "", notice: "" }); },
            }, options)),
          React.createElement("button", {
            type: "button",
            className: "dsha-btn dsha-btn-primary",
            onClick: function () { h.patch({ nameMode: s.nameMode === "new" ? "" : "new", nameDraft: "", nameError: "" }); },
          }, "New workflow")),
        s.nameMode === "new" ? renderStudioNameForm(s, h, "Create", function (name) { h.createWorkflow(name); }) : null,
        s.notice ? React.createElement("div", { className: "dsha-notice" }, s.notice) : null,
        s.wfError ? React.createElement("p", { className: "dsha-err" }, s.wfError) : null,
        s.wfList === null && !s.wfError ? React.createElement("p", { className: "dsha-muted" }, "Loading workflows…") : null,
        s.wfList && entries.length === 0 ? React.createElement("p", { className: "dsha-muted" }, "No workflows discovered for this project.") : null,
        entries.length ? React.createElement("ul", { className: "dsha-list dsha-studio-list" }, rows) : null,
        React.createElement("p", { className: "dsha-muted dsha-studio-hint" },
          "Bundled workflows open read-only — use Save as to keep an edited copy in the selected project."));
    }

    /** The one inline name row used by New, Rename and Save-as (no modals). */
    function renderStudioNameForm(s, h, label, submit) {
      return React.createElement("div", { className: "dsha-studio-nameform" },
        React.createElement("label", { className: "dsha-field dsha-field-flex" },
          React.createElement("span", { className: "dsha-field-label" }, "Workflow name"),
          React.createElement("input", {
            className: "dsha-input dsha-input-flex",
            type: "text",
            value: s.nameDraft,
            placeholder: "my-workflow",
            onChange: function (e) { h.patch({ nameDraft: e.target.value, nameError: "" }); },
            onKeyDown: function (e) { if (e.key === "Enter") submit(s.nameDraft.trim()); },
          })),
        React.createElement("button", {
          type: "button",
          className: "dsha-btn dsha-btn-primary",
          disabled: !s.nameDraft.trim() || !!s.busy,
          onClick: function () { submit(s.nameDraft.trim()); },
        }, label),
        React.createElement("button", {
          type: "button",
          className: "dsha-btn",
          onClick: function () { h.patch({ nameMode: "", nameDraft: "", nameError: "" }); },
        }, "Cancel"),
        s.nameError ? React.createElement("span", { className: "dsha-err" }, s.nameError) : null);
    }

    // ---- Studio: editor shell ------------------------------------------------

    function renderStudioEditor(s, h) {
      var edges = edgesFromModel(s.model);
      var positions = studioPositions(s, edges);
      var readOnly = isReadOnlySource(s.open.source);
      return React.createElement("div", { className: "dsha-studio-editor" },
        renderStudioToolbar(s, h, readOnly),
        s.nameMode === "rename" ? renderStudioNameForm(s, h, "Rename", function (name) { h.renameWorkflow(name); }) : null,
        s.nameMode === "saveas" ? renderStudioNameForm(s, h, "Save as", function (name) { h.saveWorkflow(name, "project"); }) : null,
        s.notice ? React.createElement("div", { className: "dsha-notice" }, s.notice) : null,
        readOnly ? React.createElement("div", { className: "dsha-studio-banner" },
          "This is a bundled workflow: it opens read-only. Save as writes an editable copy into the selected project.") : null,
        React.createElement("div", { className: "dsha-studio-body" },
          readOnly ? null : renderStudioPalette(s, h),
          renderStudioCanvas(s, h, edges, positions, readOnly),
          renderStudioInspector(s, h, readOnly)),
        s.showYaml ? React.createElement("pre", { className: "dsha-code dsha-studio-yaml" },
          serializeYamlPreview(exportDefinition(s.model))) : null,
        renderStudioIssues(s, h));
    }

    function renderStudioToolbar(s, h, readOnly) {
      var busy = !!s.busy;
      function button(label, onClick, extra) {
        return React.createElement("button", Object.assign({
          type: "button",
          className: "dsha-btn dsha-btn-small",
          onClick: onClick,
        }, extra || {}), label);
      }
      return React.createElement("div", { className: "dsha-studio-toolbar" },
        button(s.armBack ? "Discard edits?" : "‹ Back", function () { h.backToPicker(); }, { className: "dsha-btn dsha-btn-small" + (s.armBack ? " dsha-btn-danger" : "") }),
        React.createElement("span", { className: "dsha-strong" }, s.open.name),
        s.dirty ? React.createElement("span", { className: "dsha-dirty-dot", title: "Unsaved edits" }, "●") : null,
        React.createElement("span", { className: "dsha-badge-src" }, s.open.source),
        React.createElement("span", { className: "dsha-studio-spacer" }),
        button(s.busy === "validate" ? "Validating…" : "Validate", function () { h.runValidation(); }, { disabled: busy }),
        readOnly
          ? button("Save as", function () { h.patch({ nameMode: s.nameMode === "saveas" ? "" : "saveas", nameDraft: s.open.name, nameError: "" }); }, { className: "dsha-btn dsha-btn-small dsha-btn-primary", disabled: busy })
          : button(s.busy === "save" ? "Saving…" : "Save", function () { h.saveWorkflow(s.open.name, s.open.source); }, { className: "dsha-btn dsha-btn-small dsha-btn-primary", disabled: busy || !s.dirty }),
        readOnly || s.open.isNew ? null : button("Rename", function () { h.patch({ nameMode: s.nameMode === "rename" ? "" : "rename", nameDraft: s.open.name, nameError: "" }); }, { disabled: busy }),
        readOnly || s.open.isNew ? null : button(s.armDelete ? "Confirm delete?" : "Delete", function () { h.deleteWorkflow(); }, { className: "dsha-btn dsha-btn-small dsha-btn-danger", disabled: busy }),
        button(s.showYaml ? "Hide YAML" : "YAML", function () { h.patch({ showYaml: !s.showYaml }); }, { "aria-expanded": s.showYaml }),
        readOnly ? null : button("Auto-arrange", function () { h.patch({ positions: layoutGraph(s.model.nodes, edgesFromModel(s.model)) }); }),
        readOnly ? null : button("Delete selected", function () { h.deleteSelection(); }, { disabled: !s.selection }),
        React.createElement("span", { className: "dsha-studio-zoom" },
          button("−", function () { h.patch({ zoom: Math.max(0.4, Math.round((s.zoom - 0.2) * 10) / 10) }); }, { "aria-label": "Zoom out" }),
          React.createElement("span", { className: "dsha-muted" }, Math.round(s.zoom * 100) + "%"),
          button("+", function () { h.patch({ zoom: Math.min(1.6, Math.round((s.zoom + 0.2) * 10) / 10) }); }, { "aria-label": "Zoom in" })));
    }

    // ---- Studio: palette -----------------------------------------------------

    function renderStudioPalette(s, h) {
      return React.createElement("div", { className: "dsha-palette" },
        React.createElement("div", { className: "dsha-section-title" }, "Add node"),
        STUDIO_VARIANTS.map(function (variant) {
          return React.createElement("button", {
            key: variant,
            type: "button",
            className: "dsha-btn dsha-btn-small dsha-palette-btn",
            onClick: function () { h.addFromPalette(variant); },
          }, VARIANT_INFO[variant].label);
        }));
    }

    // ---- Studio: canvas ------------------------------------------------------

    function renderStudioCanvas(s, h, edges, positions, readOnly) {
      var nodes = s.model.nodes;
      var width = NODE_W + 80;
      var height = NODE_H + 80;
      nodes.forEach(function (node) {
        var at = positions[node.id] || { x: 0, y: 0 };
        if (at.x + NODE_W + 80 > width) width = at.x + NODE_W + 80;
        if (at.y + NODE_H + 80 > height) height = at.y + NODE_H + 80;
      });

      var paths = [];
      edges.forEach(function (edge) {
        var from = positions[edge.source];
        var to = positions[edge.target];
        if (!from || !to) return;
        var x1 = from.x + NODE_W / 2;
        var y1 = from.y + NODE_H;
        var x2 = to.x + NODE_W / 2;
        var y2 = to.y;
        var curve = Math.max(30, (y2 - y1) / 2);
        var d = "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + curve) + " " + x2 + " " + (y2 - curve) + " " + x2 + " " + y2;
        var selected = s.selection && s.selection.kind === "edge" && s.selection.id === edge.id;
        paths.push(React.createElement("path", {
          key: edge.id,
          className: "dsha-edge" + (selected ? " dsha-edge-selected" : ""),
          d: d,
          fill: "none",
          strokeDasharray: edge.dashed ? "6 4" : undefined,
        }));
        paths.push(React.createElement("path", {
          key: edge.id + ":hit",
          className: "dsha-edge-hit",
          d: d,
          fill: "none",
          onClick: function (e) {
            // Without this, the click bubbles to the svg's own onClick, which
            // clears the selection it just set.
            if (e && e.stopPropagation) e.stopPropagation();
            h.patch({ selection: { kind: "edge", id: edge.id, source: edge.source, target: edge.target }, pendingConnect: "" });
          },
        }));
      });

      var cards = nodes.map(function (node) {
        var at = positions[node.id] || { x: 0, y: 0 };
        var selected = s.selection && s.selection.kind === "node" && s.selection.id === node.id;
        var connecting = s.pendingConnect === node.id;
        return React.createElement("div", {
          key: node.id,
          className: "dsha-node dsha-node-" + node.variant + (selected ? " dsha-node-selected" : "") + (connecting ? " dsha-node-connecting" : ""),
          style: { left: at.x + "px", top: at.y + "px", width: NODE_W + "px", height: NODE_H + "px" },
          onPointerDown: function (e) { h.startDrag(node.id, e); },
          onClick: function () { h.selectNode(node.id); },
        },
          React.createElement("div", { className: "dsha-node-id" }, node.id),
          React.createElement("div", { className: "dsha-node-kind" }, VARIANT_INFO[node.variant].label),
          React.createElement("div", { className: "dsha-node-summary" }, nodeSummary(node)),
          readOnly
            ? null
            : React.createElement("button", {
              type: "button",
              className: "dsha-node-port",
              "aria-label": "Connect from " + node.id,
              title: "Click, then click the node that should depend on this one",
              onClick: function (e) {
                if (e && e.stopPropagation) e.stopPropagation();
                h.patch({ pendingConnect: s.pendingConnect === node.id ? "" : node.id });
              },
            }, "⊕"));
      });

      return React.createElement("div", {
        className: "dsha-canvas",
        onClick: function () { h.patch({ selection: null, pendingConnect: "" }); },
      },
        React.createElement("div", {
          className: "dsha-canvas-inner",
          style: { width: width + "px", height: height + "px", transform: "scale(" + s.zoom + ")", transformOrigin: "0 0" },
          onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); },
        },
          React.createElement("svg", {
            className: "dsha-canvas-svg",
            width: width,
            height: height,
            onClick: function () { h.patch({ selection: null, pendingConnect: "" }); },
          }, paths),
          cards,
          s.pendingConnect && !readOnly
            ? React.createElement("div", { className: "dsha-canvas-hint" }, "Click the node that should depend on '" + s.pendingConnect + "'.")
            : null));
    }

    // ---- Studio: inspector ---------------------------------------------------

    /** One labelled control row. The <label> wrapper is the programmatic label. */
    function studioField(label, control, hint) {
      return React.createElement("label", { key: label, className: "dsha-field dsha-field-block" },
        React.createElement("span", { className: "dsha-field-label" }, label),
        control,
        hint ? React.createElement("span", { className: "dsha-muted dsha-field-hint" }, hint) : null);
    }

    /**
     * Whole-number input parsing at the boundary: blank deletes the key, a
     * non-numeric entry is refused outright, so no NaN can reach the definition.
     */
    function studioParseInt(text) {
      var trimmed = String(text === undefined || text === null ? "" : text).trim();
      if (trimmed === "") return { ok: true, value: undefined };
      if (!/^\d+$/.test(trimmed)) return { ok: false };
      return { ok: true, value: Number(trimmed) };
    }

    function studioText(s, h, node, label, path, multiline, disabled) {
      var data = node.data || {};
      var value = path.length === 1 ? data[path[0]] : ((data[path[0]] || {})[path[1]]);
      var props = {
        className: "dsha-input dsha-input-block",
        value: value === undefined || value === null ? "" : String(value),
        disabled: disabled,
        onChange: function (e) { h.editData(node.id, path, e.target.value); },
      };
      if (multiline) props.rows = 4;
      return studioField(label, React.createElement(multiline ? "textarea" : "input", multiline ? props : Object.assign({ type: "text" }, props)));
    }

    function studioNumber(s, h, node, label, path, disabled) {
      var data = node.data || {};
      var value = path.length === 1 ? data[path[0]] : ((data[path[0]] || {})[path[1]]);
      return studioField(label, React.createElement("input", {
        className: "dsha-input dsha-input-block",
        type: "text",
        inputMode: "numeric",
        value: value === undefined || value === null ? "" : String(value),
        disabled: disabled,
        onChange: function (e) {
          var parsed = studioParseInt(e.target.value);
          if (!parsed.ok) return; // refuse the keystroke rather than export a NaN
          h.editData(node.id, path, parsed.value);
        },
      }), "Whole number; leave blank to remove the field.");
    }

    function studioCheckbox(s, h, node, label, path, disabled) {
      var data = node.data || {};
      var value = path.length === 1 ? data[path[0]] : ((data[path[0]] || {})[path[1]]);
      return React.createElement("label", { key: label, className: "dsha-field dsha-field-check" },
        React.createElement("input", {
          type: "checkbox",
          checked: value === true,
          disabled: disabled,
          onChange: function (e) { h.editData(node.id, path, e.target.checked ? true : undefined); },
        }),
        React.createElement("span", { className: "dsha-field-label" }, label));
    }

    function renderStudioVariantFields(s, h, node, disabled) {
      var variant = node.variant;
      if (variant === "prompt") return [studioText(s, h, node, "Prompt", ["prompt"], true, disabled)];
      if (variant === "command") {
        return [
          studioText(s, h, node, "Command", ["command"], false, disabled),
          node.data["with"] ? React.createElement("p", { key: "with", className: "dsha-muted dsha-field-hint" }, "This node passes 'with:' bindings; they are preserved as written.") : null,
        ];
      }
      if (variant === "bash") {
        return [studioText(s, h, node, "Bash script", ["bash"], true, disabled), studioNumber(s, h, node, "Timeout (ms)", ["timeout"], disabled)];
      }
      if (variant === "script") {
        return [
          studioText(s, h, node, "Script", ["script"], true, disabled),
          studioField("Runtime", React.createElement("select", {
            className: "dsha-input dsha-input-block",
            value: node.data.runtime || "bun",
            disabled: disabled,
            onChange: function (e) { h.editData(node.id, ["runtime"], e.target.value); },
          }, [
            React.createElement("option", { key: "bun", value: "bun" }, "bun"),
            React.createElement("option", { key: "uv", value: "uv" }, "uv"),
          ])),
          studioField("Dependencies", React.createElement("input", {
            className: "dsha-input dsha-input-block",
            type: "text",
            value: Array.isArray(node.data.deps) ? node.data.deps.join(", ") : "",
            disabled: disabled,
            onChange: function (e) {
              var parts = e.target.value.split(",").map(function (p) { return p.trim(); }).filter(function (p) { return p !== ""; });
              h.editData(node.id, ["deps"], parts.length ? parts : undefined);
            },
          }), "Comma-separated."),
          studioNumber(s, h, node, "Timeout (ms)", ["timeout"], disabled),
        ];
      }
      if (variant === "loop") {
        var loop = node.data.loop || {};
        var usesCommand = loop.command !== undefined;
        return [
          studioField("Prompt source", React.createElement("select", {
            className: "dsha-input dsha-input-block",
            value: usesCommand ? "command" : "prompt",
            disabled: disabled,
            onChange: function (e) { h.editLoopSource(node.id, e.target.value); },
          }, [
            React.createElement("option", { key: "prompt", value: "prompt" }, "inline prompt"),
            React.createElement("option", { key: "command", value: "command" }, "command file"),
          ])),
          usesCommand
            ? studioText(s, h, node, "Loop command", ["loop", "command"], false, disabled)
            : studioText(s, h, node, "Loop prompt", ["loop", "prompt"], true, disabled),
          studioText(s, h, node, "Until (signal)", ["loop", "until"], false, disabled),
          studioText(s, h, node, "Until (bash check)", ["loop", "until_bash"], false, disabled),
          studioText(s, h, node, "Until (output field)", ["loop", "until_field"], false, disabled),
          studioNumber(s, h, node, "Max iterations", ["loop", "max_iterations"], disabled),
          studioCheckbox(s, h, node, "Fresh context each iteration", ["loop", "fresh_context"], disabled),
          studioCheckbox(s, h, node, "Interactive", ["loop", "interactive"], disabled),
        ];
      }
      if (variant === "approval") {
        var approval = node.data.approval || {};
        return [
          studioText(s, h, node, "Message", ["approval", "message"], true, disabled),
          studioCheckbox(s, h, node, "Capture the responder's reply", ["approval", "capture_response"], disabled),
          approval.decisions
            ? React.createElement("p", { key: "decisions", className: "dsha-muted dsha-field-hint" }, "This gate declares its own decisions; they are preserved as written.")
            : null,
          approval.on_reject
            ? React.createElement("p", { key: "on_reject", className: "dsha-muted dsha-field-hint" },
              "This gate has an 'on reject' rework configuration (prompt, max attempts); it is preserved as written.")
            : null,
        ];
      }
      if (variant === "wait") {
        var wait = node.data.wait || {};
        var mode = wait.until !== undefined ? "until" : (wait.event !== undefined ? "event" : (wait.attention !== undefined ? "attention" : "duration_ms"));
        var seeds = {
          duration_ms: { duration_ms: 60000 },
          until: { until: "" },
          event: { event: "", deadline_ms: 86400000 },
          attention: { attention: "" },
        };
        var fields = [
          studioField("Wait for", React.createElement("select", {
            className: "dsha-input dsha-input-block",
            value: mode,
            disabled: disabled,
            onChange: function (e) {
              // Exactly one condition may be present, so the block is replaced whole.
              h.editData(node.id, ["wait"], seeds[e.target.value]);
            },
          }, [
            React.createElement("option", { key: "duration_ms", value: "duration_ms" }, "a duration"),
            React.createElement("option", { key: "until", value: "until" }, "a timestamp"),
            React.createElement("option", { key: "event", value: "event" }, "an event"),
            React.createElement("option", { key: "attention", value: "attention" }, "human attention"),
          ])),
        ];
        if (mode === "duration_ms") fields.push(studioNumber(s, h, node, "Duration (ms)", ["wait", "duration_ms"], disabled));
        if (mode === "until") fields.push(studioText(s, h, node, "Until (ISO-8601 UTC)", ["wait", "until"], false, disabled));
        if (mode === "event") {
          fields.push(studioText(s, h, node, "Event name", ["wait", "event"], false, disabled));
          fields.push(studioNumber(s, h, node, "Deadline (ms)", ["wait", "deadline_ms"], disabled));
        }
        if (mode === "attention") fields.push(studioText(s, h, node, "Action message", ["wait", "attention"], false, disabled));
        return fields;
      }
      if (variant === "cancel") return [studioText(s, h, node, "Reason", ["cancel"], false, disabled)];
      return [
        React.createElement("p", { key: "opaque", className: "dsha-muted dsha-field-hint" },
          "The Studio does not author this node type. Its body is preserved exactly as written; only the graph fields below are editable."),
        React.createElement("pre", { key: "raw", className: "dsha-code" }, JSON.stringify(node.data.raw, null, 2)),
      ];
    }

    function renderStudioInspector(s, h, readOnly) {
      var selected = s.selection && s.selection.kind === "node"
        ? s.model.nodes[findNodeIndex(s.model, s.selection.id)]
        : null;
      if (!selected) {
        return React.createElement("aside", { className: "dsha-inspector", "aria-label": "Node inspector" },
          React.createElement("div", { className: "dsha-section-title" }, "Inspector"),
          React.createElement("p", { className: "dsha-muted" },
            "Select a node to edit it. Click a node's ⊕ port, then another node, to make that node depend on this one."));
      }
      var disabled = readOnly;
      var preserved = preservedBaseKeys(selected);
      var deps = selected.base && Array.isArray(selected.base.depends_on) ? selected.base.depends_on : [];
      var showsAi = AI_VARIANTS.indexOf(selected.variant) !== -1;

      return React.createElement("aside", { className: "dsha-inspector", "aria-label": "Node inspector" },
        React.createElement("div", { className: "dsha-section-title" }, VARIANT_INFO[selected.variant].label + " node"),
        studioField("Node id", React.createElement("input", {
          key: selected.id,
          className: "dsha-input dsha-input-block",
          type: "text",
          defaultValue: selected.id,
          disabled: disabled,
          onBlur: function (e) { h.renameNodeId(selected.id, e.target.value); },
          onKeyDown: function (e) { if (e.key === "Enter" && e.target && e.target.blur) e.target.blur(); },
        }), "Renaming rewrites every depends_on that names it."),
        renderStudioVariantFields(s, h, selected, disabled),
        React.createElement("div", { className: "dsha-section-title dsha-inspector-sub" }, "Graph"),
        studioField("When", React.createElement("input", {
          className: "dsha-input dsha-input-block",
          type: "text",
          value: selected.base && selected.base.when !== undefined ? selected.base.when : "",
          disabled: disabled,
          onChange: function (e) { h.editBase(selected.id, "when", e.target.value === "" ? undefined : e.target.value); },
        }), "Condition expression; blank means always run."),
        studioField("Trigger rule", React.createElement("select", {
          className: "dsha-input dsha-input-block",
          value: selected.base && selected.base.trigger_rule ? selected.base.trigger_rule : "all_success",
          disabled: disabled,
          onChange: function (e) { h.editBase(selected.id, "trigger_rule", e.target.value === "all_success" ? undefined : e.target.value); },
        }, [
          React.createElement("option", { key: "all_success", value: "all_success" }, "all_success (default)"),
          React.createElement("option", { key: "any_success", value: "any_success" }, "any_success"),
          React.createElement("option", { key: "all_done", value: "all_done" }, "all_done"),
        ])),
        showsAi ? studioField("Provider", React.createElement("input", {
          className: "dsha-input dsha-input-block",
          type: "text",
          value: selected.base && selected.base.provider !== undefined ? selected.base.provider : "",
          disabled: disabled,
          onChange: function (e) { h.editBase(selected.id, "provider", e.target.value === "" ? undefined : e.target.value); },
        })) : null,
        showsAi ? studioField("Model", React.createElement("input", {
          className: "dsha-input dsha-input-block",
          type: "text",
          value: selected.base && selected.base.model !== undefined ? selected.base.model : "",
          disabled: disabled,
          onChange: function (e) { h.editBase(selected.id, "model", e.target.value === "" ? undefined : e.target.value); },
        })) : null,
        showsAi ? React.createElement("label", { className: "dsha-field dsha-field-check" },
          React.createElement("input", {
            type: "checkbox",
            checked: selected.base && selected.base.persist_session === true,
            disabled: disabled,
            onChange: function (e) { h.editBase(selected.id, "persist_session", e.target.checked ? true : undefined); },
          }),
          React.createElement("span", { className: "dsha-field-label" }, "Persist session")) : null,
        React.createElement("div", { className: "dsha-field dsha-field-block" },
          React.createElement("span", { className: "dsha-field-label" }, "Depends on"),
          deps.length
            ? React.createElement("div", { className: "dsha-deps" }, deps.map(function (dep) {
              return React.createElement("span", { key: dep, className: "dsha-dep" }, dep);
            }))
            : React.createElement("span", { className: "dsha-muted" }, "nothing — this is a root node"),
          React.createElement("span", { className: "dsha-muted dsha-field-hint" }, "Wire dependencies on the canvas.")),
        preserved.length
          ? React.createElement("p", { className: "dsha-muted dsha-field-hint" },
            preserved.length + " advanced field" + (preserved.length === 1 ? "" : "s") + " preserved as written: " + preserved.join(", ") + ".")
          : null);
    }

    // ---- Studio: issues panel ------------------------------------------------

    function renderStudioIssues(s, h) {
      var issues = (s.importIssues || []).concat(s.clientIssues || []).concat(s.serverIssues || []);
      var errors = blockingIssues(issues);
      var ordered = errors.concat(issues.filter(function (i) { return i.severity !== "error"; }));
      return React.createElement("div", { className: "dsha-issues" },
        React.createElement("div", { className: "dsha-section-title" },
          "Issues" + (issues.length ? " (" + issues.length + ")" : ""),
          errors.length
            ? React.createElement("span", { className: "dsha-err dsha-issues-block" },
              " — " + errors.length + " error" + (errors.length === 1 ? "" : "s") + " block saving")
            : null),
        ordered.length === 0
          ? React.createElement("p", { className: "dsha-muted" }, "Nothing to report. Validate to check against the server too.")
          : React.createElement("ul", { className: "dsha-list dsha-issue-list" }, ordered.map(function (issue, index) {
            return React.createElement("li", { key: index },
              React.createElement("button", {
                type: "button",
                className: "dsha-issue" + (issue.severity === "error" ? " dsha-err" : " dsha-warn"),
                disabled: !issue.nodeId,
                onClick: function () { if (issue.nodeId) h.patch({ selection: { kind: "node", id: issue.nodeId } }); },
              }, (issue.severity === "error" ? "✖ " : "⚠ ") + issue.message));
          })));
    }

    // ---- Archon settings page (DSH Settings shell) ------------------------
    // Registers as a `settings.section` page (id `archon`) beside DSH's own
    // General/Models/Plugins/… pages. Reads + writes Archon's server settings
    // through the same /archon relay: system health & concurrency, default
    // assistant + per-provider model defaults, platform connections, projects.
    // Display-only + direct user-gesture writes (data rules of report 04 §7);
    // all state is component-local, fetched on mount.

    var PLATFORMS = ["Web", "Slack", "Telegram", "Discord", "GitHub", "Gitea", "GitLab"];
    var CLAUDE_MODELS = ["sonnet", "opus", "haiku"];
    var WEBSEARCH_MODES = ["disabled", "cached", "live"];

    function cloneAssistants(map) {
      var out = {};
      Object.keys(map).forEach(function (k) { out[k] = map[k]; });
      return out;
    }

    /** One project's env vars: keys are listed, values are never returned. */
    function CodebaseEnvPanel(props) {
      var codebaseId = props.codebaseId;
      var state = React.useState({
        loading: false,
        keys: null,
        error: "",
        busy: "",
        newKey: "",
        newValue: "",
        editKey: null,
        editValue: "",
      });
      var p = state[0];
      var set = state[1];
      function patch(x) { set(function (prev) { return Object.assign({}, prev, x); }); }

      function loadKeys() {
        patch({ loading: true, error: "" });
        Archon.codebaseEnvKeys(codebaseId)
          .then(function (keys) { patch({ keys: keys, loading: false }); })
          .catch(function (e) {
            patch({ error: "env vars unavailable: " + (e && e.message ? e.message : String(e)), loading: false });
          });
      }

      function addKey() {
        var key = p.newKey.trim();
        var value = p.newValue;
        if (!key || p.busy) return;
        patch({ busy: "add", error: "" });
        Archon.setCodebaseEnv(codebaseId, key, value)
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300) {
              patch({ newKey: "", newValue: "", busy: "" });
              loadKeys();
            } else {
              patch({ error: "set failed: " + (res.error || ("http " + res.__httpStatus)), busy: "" });
            }
          })
          .catch(function (e) {
            patch({ error: "set failed: " + (e && e.message ? e.message : String(e)), busy: "" });
          });
      }

      function saveEdit(key) {
        if (p.busy) return;
        patch({ busy: "save:" + key, error: "" });
        Archon.setCodebaseEnv(codebaseId, key, p.editValue)
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300) {
              patch({ editKey: null, editValue: "", busy: "" });
              loadKeys();
            } else {
              patch({ error: "set failed: " + (res.error || ("http " + res.__httpStatus)), busy: "" });
            }
          })
          .catch(function (e) {
            patch({ error: "set failed: " + (e && e.message ? e.message : String(e)), busy: "" });
          });
      }

      function removeKey(key) {
        if (p.busy) return;
        patch({ busy: "del:" + key, error: "" });
        Archon.deleteCodebaseEnv(codebaseId, key)
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300) {
              patch({ busy: "" });
              loadKeys();
            } else {
              patch({ error: "delete failed: " + (res.error || ("http " + res.__httpStatus)), busy: "" });
            }
          })
          .catch(function (e) {
            patch({ error: "delete failed: " + (e && e.message ? e.message : String(e)), busy: "" });
          });
      }

      React.useEffect(function () { loadKeys(); return undefined; }, []);

      var rows = [];
      if (p.keys) {
        p.keys.forEach(function (key) {
          var editing = p.editKey === key;
          var busy = p.busy === "save:" + key || p.busy === "del:" + key;
          rows.push(React.createElement("div", { key: key, className: "dsha-env-row" },
            React.createElement("span", { className: "dsha-env-key" }, key),
            React.createElement("span", { className: "dsha-env-mask" }, "= ••••••"),
            editing
              ? React.createElement("input", {
                  className: "dsha-input dsha-env-input",
                  type: "password",
                  placeholder: "new value",
                  value: p.editValue,
                  disabled: busy,
                  onChange: function (e) { patch({ editValue: e.target.value }); },
                  onKeyDown: function (e) { if (e.key === "Enter") saveEdit(key); },
                })
              : null,
            React.createElement("button", {
              type: "button",
              className: "dsha-btn dsha-btn-small",
              disabled: busy,
              onClick: function () {
                if (editing) { patch({ editKey: null, editValue: "" }); }
                else { patch({ editKey: key, editValue: "" }); }
              },
            }, editing ? "Cancel" : "Edit"),
            React.createElement("button", {
              type: "button",
              className: "dsha-btn dsha-btn-small dsha-btn-danger",
              disabled: busy,
              onClick: function () { removeKey(key); },
            }, p.busy === "del:" + key ? "Removing…" : "Remove")));
        });
      }

      var body;
      if (p.loading) body = React.createElement("p", { className: "dsha-muted" }, "loading env vars…");
      else if (p.error) body = React.createElement("p", { className: "dsha-err" }, p.error);
      else if (!p.keys || p.keys.length === 0) {
        body = React.createElement("p", { className: "dsha-muted" }, "No env vars set.");
      } else {
        body = React.createElement("div", { className: "dsha-env-list" }, rows);
      }

      return React.createElement("div", { className: "dsha-env" },
        body,
        React.createElement("div", { className: "dsha-env-add" },
          React.createElement("input", {
            className: "dsha-input dsha-env-key-input",
            placeholder: "KEY",
            value: p.newKey,
            disabled: p.busy !== "",
            onChange: function (e) { patch({ newKey: e.target.value }); },
          }),
          React.createElement("input", {
            className: "dsha-input dsha-env-value-input",
            type: "password",
            placeholder: "value",
            value: p.newValue,
            disabled: p.busy !== "",
            onChange: function (e) { patch({ newValue: e.target.value }); },
            onKeyDown: function (e) { if (e.key === "Enter") addKey(); },
          }),
          React.createElement("button", {
            type: "button",
            className: "dsha-btn dsha-btn-small",
            disabled: p.busy !== "" || !p.newKey.trim(),
            onClick: addKey,
          }, p.busy === "add" ? "Adding…" : "Add")));
    }

    /** One registered project row: meta + remove + expandable env vars. */
    function ProjectRow(props) {
      var codebase = props.codebase;
      var onRemove = props.onRemove;
      var disabled = props.disabled;
      var state = React.useState({ envOpen: false, removeArmed: false });
      var st = state[0];
      var setSt = state[1];

      var meta = [];
      if (codebase.defaultCwd) meta.push(codebase.defaultCwd);
      if (codebase.kind) meta.push(codebase.kind);
      if (codebase.repositoryUrl) meta.push(codebase.repositoryUrl);

      return React.createElement("div", { className: "dsha-project" },
        React.createElement("div", { className: "dsha-project-top" },
          React.createElement("div", { className: "dsha-project-meta" },
            React.createElement("span", { className: "dsha-strong" }, codebase.name || codebase.id),
            meta.length > 0
              ? React.createElement("span", { className: "dsha-muted" }, " · " + meta.join(" · "))
              : null),
          React.createElement("div", { className: "dsha-project-actions" },
            React.createElement("button", {
              type: "button",
              className: "dsha-btn dsha-btn-small",
              disabled: disabled,
              onClick: function () { setSt({ envOpen: !st.envOpen, removeArmed: false }); },
            }, st.envOpen ? "Hide env vars" : "Env vars"),
            React.createElement("button", {
              type: "button",
              className: "dsha-btn dsha-btn-small dsha-btn-danger",
              disabled: disabled,
              onClick: function () {
                if (!st.removeArmed) { setSt({ envOpen: st.envOpen, removeArmed: true }); return; }
                onRemove(codebase.id);
              },
            }, st.removeArmed ? "Confirm remove?" : "Remove"))),
        st.envOpen ? React.createElement(CodebaseEnvPanel, { codebaseId: codebase.id }) : null);
    }

    function ArchonSettings() {
      var state = React.useState({
        loading: true,
        error: "",
        notice: "",
        conn: null,          // Archon.hostState -> { archonBaseUrl, reachable, compat }
        health: null,        // normalizeHealth view model
        config: null,        // normalizeConfig -> { assistant, assistants, database }
        providers: null,     // normalizeProviders -> [{ id, displayName, effortLevels }]
        codebases: null,     // normalizeCodebase[]
        // assistant-edit draft (server config is the source of truth)
        draftAssistant: "",
        draftAssistants: null,
        saving: false,
        saveMsg: null,       // { type: 'ok' | 'err', text }
        addOpen: false,
        addValue: "",
        addBusy: false,
        removing: "",        // codebase id mid-removal
      });
      var s = state[0];
      var set = state[1];
      function patch(p) { set(function (prev) { return Object.assign({}, prev, p); }); }

      function loadAll() {
        Promise.all([
          Archon.health().catch(function (e) { return { __error: e }; }),
          Archon.config().catch(function (e) { return { __error: e }; }),
          Archon.providers().catch(function (e) { return { __error: e }; }),
          Archon.codebases().catch(function (e) { return { __error: e }; }),
          Archon.hostState(),
        ]).then(function (results) {
          var health = results[0], config = results[1], providers = results[2], codebases = results[3], conn = results[4];
          var error = "";
          if (health && health.__error) {
            error = "Archon unreachable through the DSH relay: " + errorText(health.__error);
          } else if (health && health.status !== "ok") {
            error = "Archon health not ok: " + health.status;
          }
          patch({
            loading: false,
            error: error,
            conn: conn || null,
            health: health && !health.__error ? health : null,
            config: config && !config.__error ? config : null,
            providers: providers && !providers.__error ? providers : null,
            codebases: codebases && !codebases.__error ? codebases : null,
          });
          if (config && !config.__error) {
            patch({
              draftAssistant: config.assistant,
              draftAssistants: cloneAssistants(config.assistants),
            });
          }
        });
      }

      function loadCodebases() {
        Archon.codebases().catch(function (e) { return { __error: e }; })
          .then(function (cb) {
            patch({ codebases: cb && !cb.__error ? cb : null });
          });
      }

      React.useEffect(function () { loadAll(); return undefined; }, []);

      // ---- assistant config editor ----------------------------------------

      function updateAssistantField(providerId, field, value) {
        set(function (prev) {
          var drafts = prev.draftAssistants || {};
          var next = {};
          Object.keys(drafts).forEach(function (k) { next[k] = drafts[k]; });
          var entry = Object.assign({}, drafts[providerId] || {});
          if (value === null || value === undefined || value === "") {
            delete entry[field];
          } else {
            entry[field] = value;
          }
          next[providerId] = entry;
          return Object.assign({}, prev, { draftAssistants: next });
        });
      }

      function saveAssistant() {
        if (s.saving) return;
        patch({ saving: true, saveMsg: null });
        Archon.saveAssistants(s.draftAssistant, s.draftAssistants)
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300 && res.config) {
              var cfg = normalizeConfig(res);
              patch({
                config: cfg,
                draftAssistant: cfg.assistant,
                draftAssistants: cloneAssistants(cfg.assistants),
                saveMsg: { type: "ok", text: "Assistant settings saved." },
              });
            } else {
              patch({ saveMsg: { type: "err", text: "Save failed: " + (res.error || ("http " + res.__httpStatus)) } });
            }
          })
          .catch(function (e) {
            patch({ saveMsg: { type: "err", text: "Save failed: " + (e && e.message ? e.message : String(e)) } });
          })
          .then(function () { patch({ saving: false }); });
      }

      function setDraftAssistant(value) { patch({ draftAssistant: value }); }

      // ---- project management ---------------------------------------------

      function addProject() {
        var value = s.addValue.trim();
        if (!value || s.addBusy) return;
        patch({ addBusy: true, notice: "" });
        Archon.registerCodebase(value)
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300) {
              patch({ addOpen: false, addValue: "", addBusy: false, notice: "Project registered." });
              loadCodebases();
            } else {
              patch({ addBusy: false, notice: "Add failed: " + (res.error || ("http " + res.__httpStatus)) });
            }
          })
          .catch(function (e) {
            patch({ addBusy: false, notice: "Add failed: " + (e && e.message ? e.message : String(e)) });
          });
      }

      function removeProject(id) {
        if (s.removing) return;
        patch({ removing: id, notice: "" });
        Archon.removeCodebase(id)
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300) {
              patch({ removing: "", notice: "Project removed." });
              loadCodebases();
            } else {
              patch({ removing: "", notice: "Remove failed: " + (res.error || ("http " + res.__httpStatus)) });
            }
          })
          .catch(function (e) {
            patch({ removing: "", notice: "Remove failed: " + (e && e.message ? e.message : String(e)) });
          });
      }

      // ---- derived ----------------------------------------------------------

      var cfgConfig = s.config;
      var providersList = Array.isArray(s.providers) ? s.providers : [];
      var drafts = s.draftAssistants || {};

      var dirty = !!(cfgConfig && (
        (s.draftAssistant || "") !== (cfgConfig.assistant || "") ||
        JSON.stringify(drafts) !== JSON.stringify(cfgConfig.assistants || {})
      ));

      // Every registered provider + every config-only provider that still has
      // stored defaults (mirrors Archon's own Settings page).
      var providerById = {};
      providersList.forEach(function (p) { providerById[p.id] = p; });
      var entryIds = [];
      providersList.forEach(function (p) {
        if (entryIds.indexOf(p.id) === -1) entryIds.push(p.id);
      });
      Object.keys(drafts).forEach(function (id) {
        if (entryIds.indexOf(id) === -1) entryIds.push(id);
      });

      // ---- render ------------------------------------------------------------

      if (s.loading) {
        return React.createElement("div", { className: "dsha-settings" },
          React.createElement("p", { className: "dsha-muted" }, "Loading Archon settings…"));
      }

      if (s.error) {
        var hint = s.conn && s.conn.archonBaseUrl
          ? s.conn.archonBaseUrl
          : "http://127.0.0.1:3090";
        return React.createElement("div", { className: "dsha-settings" },
          React.createElement("div", { className: "dsha-set-error" },
            React.createElement("div", { className: "dsha-strong" }, "Archon unreachable"),
            React.createElement("p", null, s.error),
            React.createElement("p", { className: "dsha-muted" },
              "The DSH host relays to \"" + hint + "\". Start an Archon server there " +
              "(default: an Archon v0.10 server on port 3090) or restart dsh with " +
              "DSH_ARCHON_BASE_URL set, then reopen this page.")));
      }

      var notice = s.notice
        ? React.createElement("div", { className: "dsha-set-notice" }, s.notice)
        : null;

      return React.createElement("div", { className: "dsha-settings" },
        notice,
        renderSettingsServer(s, cfgConfig),
        renderSettingsAssistant(s, entryIds, providerById, updateAssistantField, setDraftAssistant, saveAssistant, dirty),
        renderSettingsPlatforms(s.health),
        renderSettingsProjects(s, patch, addProject, removeProject));
    }

    function renderSettingsServer(s, cfgConfig) {
      var h = s.health;
      if (!h) return null;
      var concurrency = h.concurrency || {};
      var maxc = concurrency.maxConcurrent;
      var active = concurrency.active;
      var pct = (maxc > 0 && typeof active === "number") ? Math.min(100, Math.round((active / maxc) * 100)) : 0;

      var cells = [kv("Status", React.createElement("span", { className: "dsha-status " + statusClass(h.status) }, h.status))];
      if (h.version) cells.push(kv("Version", h.version));
      if (cfgConfig) cells.push(kv("Database", cfgConfig.database));
      if (h.adapter) cells.push(kv("Adapter", h.adapter));
      if (typeof h.runningWorkflows === "number") cells.push(kv("Running workflows", String(h.runningWorkflows)));
      if (s.conn) cells.push(kv("Relay target", s.conn.archonBaseUrl));
      if (s.conn && s.conn.compat && s.conn.compat.compatible !== null) {
        cells.push(kv("Compatibility", React.createElement("span", {
          className: s.conn.compat.compatible ? "" : "dsha-warn",
          title: s.conn.compat.reason,
        }, s.conn.compat.compatible ? "tested range (" + s.conn.compat.min + " to < " + s.conn.compat.below + ")" : "untested: " + s.conn.compat.reason)));
      }

      var concurrencyEl = null;
      if (maxc > 0 || typeof active === "number") {
        concurrencyEl = React.createElement("div", { className: "dsha-set-row dsha-set-row-wide" },
          React.createElement("span", { className: "dsha-set-label" }, "Concurrency"),
          React.createElement("div", { className: "dsha-set-val" },
            React.createElement("div", { className: "dsha-bar" },
              React.createElement("div", { className: "dsha-bar-fill", style: { width: String(pct) + "%" } })),
            React.createElement("div", { className: "dsha-muted dsha-set-hint" },
              String(typeof active === "number" ? active : 0) + " / " + String(maxc) + " concurrent conversations")));
      }

      return React.createElement("div", { className: "dsha-section dsha-set-card" },
        React.createElement("h3", { className: "dsha-section-title" }, "Server & System"),
        React.createElement("div", { className: "dsha-set-grid" }, cells),
        concurrencyEl);
    }

    function kv(label, value) {
      return React.createElement("div", { className: "dsha-set-kv", key: label },
        React.createElement("span", { className: "dsha-muted" }, label),
        React.createElement("span", { className: "dsha-set-kvval" }, value));
    }

    function renderSettingsAssistant(s, entryIds, providerById, updateAssistantField, setDraftAssistant, saveAssistant, dirty) {
      var drafts = s.draftAssistants || {};
      var assistantOptions = entryIds.map(function (id) {
        var p = providerById[id];
        return React.createElement("option", { key: id, value: id }, p && p.displayName ? p.displayName : id);
      });
      if (entryIds.length === 0) {
        assistantOptions = React.createElement("option", { key: "", value: "" }, "no providers registered");
      }

      var providerEditors = entryIds.map(function (id) {
        var p = providerById[id];
        var displayName = p && p.displayName ? p.displayName : id;
        var settings = drafts[id] || {};
        var keys = Object.keys(settings);

        if (id === "claude") {
          var claudeModel = settings.model || "sonnet";
          return React.createElement("div", { key: id, className: "dsha-set-provider" },
            React.createElement("div", { className: "dsha-strong" }, displayName),
            React.createElement("span", { className: "dsha-muted dsha-set-provider-sub" }, "Built-in provider settings"),
            React.createElement("div", { className: "dsha-set-row" },
              React.createElement("label", { className: "dsha-set-label", htmlFor: "dsha-claude-model" }, "Model"),
              React.createElement("select", {
                id: "dsha-claude-model",
                className: "dsha-input",
                value: claudeModel,
                onChange: function (e) { updateAssistantField("claude", "model", e.target.value); },
              }, CLAUDE_MODELS.map(function (m) {
                return React.createElement("option", { key: m, value: m }, m);
              }))));
        }

        if (id === "codex") {
          var provider = providerById["codex"];
          var effortOptions = provider && Array.isArray(provider.effortLevels) ? provider.effortLevels : null;
          return React.createElement("div", { key: id, className: "dsha-set-provider" },
            React.createElement("div", { className: "dsha-strong" }, displayName),
            React.createElement("span", { className: "dsha-muted dsha-set-provider-sub" }, "Built-in provider settings"),
            React.createElement("div", { className: "dsha-set-row" },
              React.createElement("label", { className: "dsha-set-label", htmlFor: "dsha-codex-model" }, "Model"),
              React.createElement("input", {
                id: "dsha-codex-model",
                className: "dsha-input dsha-input-flex",
                type: "text",
                placeholder: "gpt-5.6-sol",
                value: settings.model || "",
                onChange: function (e) { updateAssistantField("codex", "model", e.target.value); },
              })),
            effortOptions
              ? React.createElement("div", { className: "dsha-set-row" },
                  React.createElement("label", { className: "dsha-set-label", htmlFor: "dsha-codex-effort" }, "Reasoning Effort"),
                  React.createElement("select", {
                    id: "dsha-codex-effort",
                    className: "dsha-input",
                    value: settings.modelReasoningEffort || "",
                    onChange: function (e) { updateAssistantField("codex", "modelReasoningEffort", e.target.value); },
                  }, effortOptions.map(function (e) {
                    return React.createElement("option", { key: e, value: e }, e);
                  })))
              : null,
            React.createElement("div", { className: "dsha-set-row" },
              React.createElement("label", { className: "dsha-set-label", htmlFor: "dsha-codex-search" }, "Web Search"),
              React.createElement("select", {
                id: "dsha-codex-search",
                className: "dsha-input",
                value: settings.webSearchMode || "disabled",
                onChange: function (e) { updateAssistantField("codex", "webSearchMode", e.target.value); },
              }, WEBSEARCH_MODES.map(function (m) {
                return React.createElement("option", { key: m, value: m }, m);
              }))));
        }

        // Generic provider: Phase-2 storage — read-only JSON when anything set.
        if (keys.length === 0) {
          return React.createElement("div", { key: id, className: "dsha-set-provider" },
            React.createElement("div", { className: "dsha-strong" }, displayName),
            React.createElement("span", { className: "dsha-muted dsha-set-provider-sub" },
              "No provider defaults stored yet."));
        }
        return React.createElement("div", { key: id, className: "dsha-set-provider" },
          React.createElement("div", { className: "dsha-strong" }, displayName),
          React.createElement("details", { className: "dsha-set-raw" },
            React.createElement("summary", null, "Provider-specific settings (stored generically)"),
            React.createElement("pre", { className: "dsha-code" }, JSON.stringify(settings, null, 2))));
      });

      var saveMsg = s.saveMsg
        ? React.createElement("span", {
            className: "dsha-set-save-msg " + (s.saveMsg.type === "ok" ? "dsha-ok" : "dsha-err"),
          }, s.saveMsg.text)
        : null;

      return React.createElement("div", { className: "dsha-section dsha-set-card" },
        React.createElement("h3", { className: "dsha-section-title" }, "Assistant Configuration"),
        React.createElement("div", { className: "dsha-set-row" },
          React.createElement("label", { className: "dsha-set-label", htmlFor: "dsha-default-assistant" }, "Default Assistant"),
          React.createElement("select", {
            id: "dsha-default-assistant",
            className: "dsha-input",
            value: s.draftAssistant || "",
            onChange: function (e) { setDraftAssistant(e.target.value); },
          }, assistantOptions)),
        React.createElement("div", { className: "dsha-set-providers" }, providerEditors),
        React.createElement("div", { className: "dsha-set-actions" },
          React.createElement("button", {
            type: "button",
            className: "dsha-btn dsha-btn-primary",
            disabled: !dirty || s.saving,
            onClick: saveAssistant,
          }, s.saving ? "Saving…" : "Save Changes"),
          saveMsg));
    }

    function renderSettingsPlatforms(health) {
      if (!health) return null;
      var activeIds = Array.isArray(health.activePlatforms) ? health.activePlatforms : [];
      return React.createElement("div", { className: "dsha-section dsha-set-card" },
        React.createElement("h3", { className: "dsha-section-title" }, "Platform Connections"),
        React.createElement("div", { className: "dsha-set-rows" },
          PLATFORMS.map(function (name) {
            var on = activeIds.indexOf(name) !== -1;
            return React.createElement("div", { key: name, className: "dsha-set-row" },
              React.createElement("span", { className: "dsha-set-label" }, name),
              React.createElement("span", { className: "dsha-set-val" },
                React.createElement("span", { className: "dsha-badge" + (on ? " dsha-badge-on" : " dsha-badge-off") },
                  on ? "Connected" : "Not configured")));
          })));
    }

    function renderSettingsProjects(s, patch, addProject, removeProject) {
      var codebases = s.codebases;
      var list;
      if (codebases === null) {
        list = React.createElement("p", { className: "dsha-muted" }, "No response.");
      } else if (!Array.isArray(codebases) || codebases.length === 0) {
        list = React.createElement("p", { className: "dsha-muted" },
          "No registered projects. Add a GitHub URL or a local repository path below — the Archon server registers it in its own database.");
      } else {
        list = React.createElement("div", { className: "dsha-set-projects" },
          codebases.map(function (cb) {
            return React.createElement(ProjectRow, {
              key: cb.id,
              codebase: cb,
              disabled: s.removing !== "",
              onRemove: removeProject,
            });
          }));
      }

      var addForm;
      if (s.addOpen) {
        addForm = React.createElement("div", { className: "dsha-set-addproject" },
          React.createElement("input", {
            className: "dsha-input dsha-input-flex",
            type: "text",
            placeholder: "GitHub URL or local repository path",
            value: s.addValue,
            disabled: s.addBusy,
            onChange: function (e) { patch({ addValue: e.target.value }); },
            onKeyDown: function (e) { if (e.key === "Enter") addProject(); },
          }),
          React.createElement("button", {
            type: "button",
            className: "dsha-btn dsha-btn-primary",
            disabled: s.addBusy || !s.addValue.trim(),
            onClick: addProject,
          }, s.addBusy ? "Adding…" : "Register"),
          React.createElement("button", {
            type: "button",
            className: "dsha-btn",
            disabled: s.addBusy,
            onClick: function () { patch({ addOpen: false, addValue: "" }); },
          }, "Cancel"));
      } else {
        addForm = React.createElement("div", { className: "dsha-set-addproject" },
          React.createElement("button", {
            type: "button",
            className: "dsha-btn",
            onClick: function () { patch({ addOpen: true }); },
          }, "+ Add project"));
      }

      return React.createElement("div", { className: "dsha-section dsha-set-card" },
        React.createElement("h3", { className: "dsha-section-title" }, "Projects"),
        list,
        addForm);
    }

    function ArchonTool(props) {
      var useSessions = props && typeof props.useSessions === "function" ? props.useSessions : null;
      var list = useSessions ? useSessions(function (st) { return st; }) : null;
      var current = list ? list.current : undefined;
      return React.createElement("button", {
        type: "button",
        title: "Open Archon console",
        "aria-label": "Archon",
        className: "dsha-tool",
        onClick: function () { requestOpenArchon(current); },
      }, React.createElement("span", { style: { fontSize: "14px", lineHeight: 1 } }, "◆"));
    }

    var CSS = [
      ".dsha-view{width:100%;height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;font-family:var(--dsw-font-family,system-ui,sans-serif);font-size:13px;color:var(--dsw-alias-label-primary,#e6e9ef)}",
      ".dsha-header{flex:none;display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}",
      ".dsha-title{font-size:15px;font-weight:600}",
      ".dsha-modes{display:flex;gap:4px;align-items:center}",
      ".dsha-mode{height:24px;padding:0 10px;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);cursor:pointer;font-size:12px}",
      ".dsha-mode-active{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#e6e9ef)}",
      ".dsha-mode:hover{color:var(--dsw-alias-label-primary,#e6e9ef)}",
      ".dsha-sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-refresh{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e9ef);cursor:pointer;font-size:12px}",
      ".dsha-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".dsha-notice{padding:6px 14px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}",
      ".dsha-console{flex:1;min-height:0;min-width:0;display:flex}",
      ".dsha-body{flex:1;min-height:0;min-width:0;overflow:auto;padding:4px 14px 24px;box-sizing:border-box}",
      ".dsha-section{margin-top:14px}",
      ".dsha-section-title{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9aa4b2);margin:0 0 6px}",
      ".dsha-launch{display:flex;gap:8px;align-items:center;margin-top:12px;padding:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}",
      ".dsha-input{flex:none;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-base,rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#e6e9ef);font-size:12px;max-width:320px}",
      ".dsha-input-flex{flex:1;min-width:120px;max-width:none}",
      ".dsha-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e9ef);cursor:pointer;font-size:12px;white-space:nowrap}",
      ".dsha-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".dsha-btn:disabled{opacity:.5;cursor:default}",
      ".dsha-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b82f6));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".dsha-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#3b82f6))}",
      ".dsha-btn-danger{color:var(--dsw-alias-state-error-primary,#dc2626)}",
      ".dsha-btn-small{height:22px;padding:0 8px;font-size:11px;margin-right:4px}",
      ".dsha-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}",
      ".dsha-list li{padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1))}",
      ".dsha-wf li{padding:6px 0}",
      ".dsha-strong{font-weight:600}",
      ".dsha-muted{color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-err{color:#ef4444}",
      ".dsha-src{color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:11px}",
      ".dsha-desc{color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12px;margin-top:2px;line-height:1.45;max-width:820px}",
      ".dsha-runs{width:100%;border-collapse:collapse;font-size:12px}",
      ".dsha-runs th{text-align:left;color:var(--dsw-alias-label-secondary,#9aa4b2);font-weight:600;padding:3px 8px 3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}",
      ".dsha-runs td{padding:3px 8px 3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.08));vertical-align:top}",
      ".dsha-status{display:inline-block;padding:0 6px;border-radius:8px;font-size:11px;font-weight:600;line-height:16px}",
      ".dsha-status.running{background:rgba(59,130,246,.18);color:#93c5fd}",
      ".dsha-status.pending{background:rgba(148,163,184,.16);color:#cbd5e1}",
      ".dsha-status.ok{background:rgba(22,163,74,.18);color:#86efac}",
      ".dsha-status.err{background:rgba(239,68,68,.18);color:#fca5a5}",
      ".dsha-status.warn{background:rgba(234,179,8,.18);color:#fde047}",
      ".dsha-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}",
      ".dsha-chat{flex:1;min-height:0;display:flex;padding:8px 14px 14px;gap:12px;box-sizing:border-box}",
      ".dsha-chat-side{flex:none;width:250px;display:flex;flex-direction:column;gap:6px;min-height:0}",
      ".dsha-chat-side .dsha-section-title{margin:4px 0 0}",
      ".dsha-chat-new{width:100%}",
      ".dsha-chat-err{margin-top:6px;font-size:12px}",
      ".dsha-chat-main{flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:8px;min-height:0}",
      ".dsha-chat-log{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px}",
      ".dsha-chat-empty{color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12px;margin:auto;text-align:center;max-width:380px;line-height:1.5}",
      ".dsha-bubble{max-width:82%;padding:6px 10px;border-radius:10px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15))}",
      ".dsha-bubble-user{align-self:flex-end;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;border-color:transparent}",
      ".dsha-bubble-assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12))}",
      ".dsha-stream::after{content:'▋';animation:dsha-blink 1s step-start infinite}",
      "@keyframes dsha-blink{50%{opacity:0}}",
      ".dsha-composer{flex:none;display:flex;gap:8px;padding:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}",
      ".dsha-tool{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;padding:0}",
      ".dsha-tool:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e9ef)}",
      ".dsha-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-2px}",
      ".dsha-settings{padding:2px 2px 10px;font-size:13px}",
      ".dsha-set-card{margin-top:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}",
      ".dsha-set-card .dsha-section-title{margin:0 0 8px}",
      ".dsha-set-error{border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.08);border-radius:8px;padding:10px 12px;margin-top:10px;line-height:1.5}",
      ".dsha-set-notice{padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:6px;margin-top:10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}",
      ".dsha-set-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:4px 14px;padding:2px 0 6px}",
      ".dsha-set-kv{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dsha-set-kvval{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".dsha-set-rows{display:flex;flex-direction:column;gap:2px}",
      ".dsha-set-row{display:flex;align-items:center;gap:8px;min-height:26px}",
      ".dsha-set-row-wide{margin-top:8px}",
      ".dsha-set-label{flex:none;width:180px;color:var(--dsw-alias-label-secondary,#9aa4b2);min-width:0}",
      ".dsha-set-val{flex:1;min-width:0}",
      ".dsha-set-hint{font-size:11px;margin-top:3px}",
      ".dsha-set-provider{margin-top:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));border-radius:6px;display:flex;flex-direction:column;gap:4px}",
      ".dsha-set-provider-sub{font-size:11px;margin-left:8px}",
      ".dsha-set-providers{display:flex;flex-direction:column;margin-top:2px}",
      ".dsha-set-raw{margin-top:2px;font-size:12px}",
      ".dsha-set-raw summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-set-actions{display:flex;align-items:center;gap:10px;margin-top:10px}",
      ".dsha-set-save-msg{font-size:12px}",
      ".dsha-set-addproject{display:flex;gap:8px;align-items:center;margin-top:8px}",
      ".dsha-set-addproject .dsha-input-flex{max-width:none}",
      ".dsha-bar{height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));overflow:hidden;max-width:360px}",
      ".dsha-bar-fill{height:100%;background:var(--dsw-alias-brand-primary,#3b82f6);border-radius:3px}",
      ".dsha-badge{display:inline-block;padding:0 8px;border-radius:9px;font-size:11px;font-weight:600;line-height:18px}",
      ".dsha-badge-on{background:rgba(22,163,74,.18);color:#86efac}",
      ".dsha-badge-off{background:rgba(148,163,184,.16);color:#cbd5e1}",
      ".dsha-set-projects{margin-top:2px}",
      ".dsha-project{padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1))}",
      ".dsha-project-top{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:26px}",
      ".dsha-project-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsha-project-actions{flex:none;display:flex;gap:4px}",
      ".dsha-env{margin:6px 0 2px 12px;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));display:flex;flex-direction:column;gap:6px}",
      ".dsha-env-list{display:flex;flex-direction:column;gap:2px}",
      ".dsha-env-row{display:flex;align-items:center;gap:6px}",
      ".dsha-env-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;min-width:110px}",
      ".dsha-env-mask{color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:11px}",
      ".dsha-env-input{flex:1;min-width:80px;height:24px;font-size:12px}",
      ".dsha-env-key-input{width:130px;flex:none}",
      ".dsha-env-value-input{flex:1;min-width:110px;max-width:none}",
      ".dsha-env-add{display:flex;gap:6px;align-items:center}",
      ".dsha-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-base,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));border-radius:6px;padding:8px;overflow:auto;margin:4px 0 0}",
      ".dsha-ok{color:#86efac}",
      ".dsha-detail{flex:none;width:400px;display:flex;flex-direction:column;gap:2px;overflow:auto;padding:8px 12px 20px;box-sizing:border-box;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}",
      ".dsha-detail-top{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}",
      ".dsha-detail-top .dsha-section-title{margin:0}",
      ".dsha-detail-head{display:flex;flex-direction:column;gap:3px;padding:8px 0}",
      ".dsha-detail-name{display:flex;align-items:center;gap:8px;margin-bottom:4px}",
      ".dsha-detail-row{display:flex;gap:8px;align-items:baseline;font-size:12px}",
      ".dsha-detail-label{flex:none;width:86px;color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-detail-value{flex:1;min-width:0;word-break:break-word}",
      ".dsha-detail-msg{display:block;max-height:88px;overflow:auto;white-space:pre-wrap;line-height:1.45}",
      ".dsha-detail-section{margin-top:12px}",
      ".dsha-detail-section .dsha-section-title{margin:0 0 6px}",
      ".dsha-timeline{margin:0;padding:0;list-style:none;max-height:320px;overflow:auto;font-size:12px}",
      ".dsha-timeline li{padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.08))}",
      ".dsha-timeline-time{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-right:6px}",
      ".dsha-timeline-type{font-weight:600}",
      ".dsha-timeline-step{margin-left:6px;color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-timeline-data{margin-top:2px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);line-height:1.4;word-break:break-word}",
      ".dsha-artifacts{margin:0;padding:0;list-style:none}",
      ".dsha-artifact{display:flex;width:100%;align-items:baseline;justify-content:space-between;gap:8px;padding:4px 0;border:0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1));background:transparent;color:var(--dsw-alias-label-primary,#e6e9ef);font-size:12px;text-align:left;cursor:pointer}",
      ".dsha-artifact:hover{color:var(--dsw-alias-brand-primary,#3b82f6)}",
      ".dsha-artifact-open{font-weight:600}",
      ".dsha-artifact-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;min-width:0;word-break:break-all}",
      ".dsha-preview{max-height:280px;white-space:pre-wrap;word-break:break-word}",
      ".dsha-preview-note{margin:4px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-link{color:var(--dsw-alias-brand-primary,#3b82f6)}",
      ".dsha-warn{color:var(--dsw-alias-state-warn-label,#d4a04f)}",
      ".dsha-studio{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;padding:8px 14px 12px;box-sizing:border-box;gap:8px}",
      ".dsha-studio-picker{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}",
      ".dsha-studio-pickbar{flex:none;display:flex;gap:12px;align-items:flex-end}",
      ".dsha-studio-list{gap:0}",
      ".dsha-studio-row{display:flex;align-items:center;gap:8px;padding:5px 0}",
      ".dsha-studio-rowdesc{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      ".dsha-studio-row .dsha-btn{margin-left:auto}",
      ".dsha-studio-row .dsha-strong{min-width:180px}",
      ".dsha-studio-hint{font-size:12px;margin:4px 0 0}",
      ".dsha-studio-nameform{flex:none;display:flex;gap:8px;align-items:flex-end;padding:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}",
      ".dsha-studio-editor{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}",
      ".dsha-studio-toolbar{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}",
      ".dsha-studio-spacer{flex:1}",
      ".dsha-studio-zoom{display:inline-flex;align-items:center;gap:4px}",
      ".dsha-studio-banner{flex:none;padding:6px 10px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}",
      ".dsha-studio-body{flex:1;min-height:220px;display:flex;gap:8px;min-width:0}",
      ".dsha-studio-yaml{flex:none;max-height:220px}",
      ".dsha-palette{flex:none;width:120px;display:flex;flex-direction:column;gap:4px;overflow:auto}",
      ".dsha-palette-btn{width:100%;text-align:left}",
      ".dsha-canvas{flex:1;min-width:0;position:relative;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-radius:8px;background-color:var(--dsw-alias-bg-base,rgba(0,0,0,.12));background-image:radial-gradient(var(--dsw-alias-border-l2,rgba(127,127,127,.3)) 1px,transparent 1px);background-size:16px 16px}",
      ".dsha-canvas-inner{position:relative}",
      ".dsha-canvas-svg{position:absolute;left:0;top:0;overflow:visible}",
      ".dsha-canvas-hint{position:sticky;left:8px;top:8px;display:inline-block;padding:4px 8px;border-radius:6px;font-size:11px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-node{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:6px 8px;overflow:hidden;cursor:grab;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-left-width:3px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(30,32,38,.94));color:var(--dsw-alias-label-primary,#e6e9ef)}",
      ".dsha-node:hover{border-color:var(--dsw-alias-brand-primary,#3b82f6)}",
      ".dsha-node-selected{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
      ".dsha-node-connecting{outline:2px dashed var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
      ".dsha-node-id{font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsha-node-kind{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-node-summary{font-size:11px;line-height:1.35;color:var(--dsw-alias-label-secondary,#9aa4b2);overflow:hidden}",
      ".dsha-node-port{position:absolute;right:4px;bottom:2px;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);cursor:pointer;font-size:13px;line-height:1}",
      ".dsha-node-port:hover{color:var(--dsw-alias-brand-primary,#3b82f6)}",
      ".dsha-node-prompt{border-left-color:var(--dsw-alias-brand-primary,#3b82f6)}",
      ".dsha-node-command{border-left-color:var(--dsw-alias-state-info-primary,#38bdf8)}",
      ".dsha-node-bash{border-left-color:var(--dsw-alias-state-success-primary,#22c55e)}",
      ".dsha-node-script{border-left-color:var(--dsw-alias-brand-secondary,#a78bfa)}",
      ".dsha-node-loop{border-left-color:var(--dsw-alias-state-warn-primary,#eab308)}",
      ".dsha-node-approval{border-left-color:var(--dsw-alias-state-warn-label,#d4a04f)}",
      ".dsha-node-wait{border-left-color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-node-cancel{border-left-color:var(--dsw-alias-state-error-primary,#dc2626)}",
      ".dsha-node-opaque{border-left-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3))}",
      ".dsha-edge{stroke:var(--dsw-alias-border-l2,rgba(127,127,127,.45));stroke-width:1.5}",
      ".dsha-edge-selected{stroke:var(--dsw-alias-brand-primary,#3b82f6);stroke-width:2.5}",
      ".dsha-edge-hit{stroke:transparent;stroke-width:12;cursor:pointer}",
      ".dsha-inspector{flex:none;width:300px;display:flex;flex-direction:column;gap:6px;overflow:auto;padding:0 4px 8px 10px;box-sizing:border-box;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}",
      ".dsha-inspector-sub{margin-top:8px}",
      ".dsha-field{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dsha-field-block{flex-direction:column;align-items:stretch;gap:3px}",
      ".dsha-field-flex{flex:1;min-width:0}",
      ".dsha-field-check{flex-direction:row;align-items:center;gap:6px}",
      ".dsha-field-label{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2)}",
      ".dsha-field-hint{font-size:11px;line-height:1.4}",
      ".dsha-input-block{max-width:none;width:100%;box-sizing:border-box}",
      ".dsha-studio textarea.dsha-input{height:auto;min-height:64px;padding:6px 8px;line-height:1.45;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}",
      ".dsha-deps{display:flex;flex-wrap:wrap;gap:4px}",
      ".dsha-dep{padding:0 8px;border-radius:9px;font-size:11px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}",
      ".dsha-issues{flex:none;max-height:150px;overflow:auto}",
      ".dsha-issues-block{font-weight:600}",
      ".dsha-issue-list li{border:0;padding:1px 0}",
      ".dsha-issue{border:0;background:transparent;padding:0;text-align:left;font-size:12px;line-height:1.45;cursor:pointer;font-family:inherit}",
      ".dsha-issue:disabled{cursor:default}",
      ".dsha-dirty-dot{color:var(--dsw-alias-state-warn-label,#d4a04f);font-size:10px}",
      ".dsha-badge-src{padding:0 6px;border-radius:8px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary,#9aa4b2);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}",
    ].join("\n");

    var inject = ["slots", "sessions"];

    function apply(ctx) {
      if (typeof document !== "undefined" && !document.querySelector("style[data-dsha]")) {
        var tag = document.createElement("style");
        tag.setAttribute("data-dsha", "1");
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register(
          { name: "conversation.view", id: "archon", order: 30, label: "Archon" },
          function (props) { return React.createElement(ArchonConsole, props); },
        );
      });
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "archon", order: 12, label: "Archon" },
          function (props) { return React.createElement(ArchonTool, props); },
        );
      });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: "archon", order: 30, label: "Archon" },
          function (props) { return React.createElement(ArchonSettings, props); },
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
