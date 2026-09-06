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
 *   - a **launch panel**: pick a workflow, give it a message, run it
 *     (POST /archon/api/workflows/{name}/run)
 *   - a **Chat** mode: pick or create a web conversation on a registered
 *     codebase, stream the routing agent's replies and tool activity over
 *     /archon/api/stream/{conversationId} (SSE), and send messages
 *     (POST /archon/api/conversations/{id}/message)
 * Live progress: an EventSource to /archon/api/stream/__dashboard__ invalidates
 * the runs + health views on workflow_status / dag_node frames.
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

    // ---- conversation view activation bridge ------------------------------
    // Sidebar tool (root scope) asks the mounted Session to open this view via
    // a window event; ConversationSession answers with an echo. Names kept in
    // lockstep with ui-conversation's ConversationSession.tsx.

    var OPEN_VIEW_EVENT = "dsh:conversation.open-view";

    function requestOpenArchon(sessionId) {
      if (!sessionId) return;
      window.dispatchEvent(new CustomEvent(OPEN_VIEW_EVENT, {
        detail: { view: "archon", sessionId: sessionId },
      }));
    }

    // ---- Archon API (same-origin through the host relay) ------------------

    var API = "/archon/api";
    var SSE = API + "/stream/__dashboard__";

    /** GET JSON from the relay; rejects on non-2xx. */
    function getJson(path) {
      return fetch(API + path, { headers: { accept: "application/json" } })
        .then(function (r) {
          if (!r.ok) throw new Error("http " + r.status);
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

    function timeAgo(iso) {
      if (!iso) return "";
      var t = Date.parse(iso);
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

    /** Which run controls make sense for a run status. */
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
        mode: "console", // "console" | "chat"
        health: null,
        codebases: null,
        workflows: null,
        runs: null,
        error: "",
        notice: "",
        launching: false,
        launchWorkflow: "",
        launchMessage: "",
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
          getJson("/health").catch(function (e) { return { __error: e }; }),
          getJson("/codebases").catch(function (e) { return { __error: e }; }),
          getJson("/workflows").catch(function (e) { return { __error: e }; }),
          getJson("/workflows/runs?limit=30").catch(function (e) { return { __error: e }; }),
        ]).then(function (results) {
          var health = results[0], codebases = results[1], workflows = results[2], runs = results[3];
          var error = "";
          if (health && health.__error) error = "Archon unreachable via relay: " + String(health.__error.message || health.__error);
          else if (health && health.status !== "ok") error = "Archon health not ok: " + JSON.stringify(health);
          patch({ health: health && !health.__error ? health : null, error: error });
          patch({ codebases: codebases && !codebases.__error ? codebases : null });
          patch({ workflows: workflows && !workflows.__error ? workflows : null });
          patch({ runs: runs && !runs.__error ? runs : null });
        });
      }

      // ---- run control actions --------------------------------------------

      function runControl(run, verb) {
        if (store.busy) return;
        var label = CONTROL_LABELS[verb] || verb;
        var body = verb === "reject" ? { reason: "Rejected from dsh-archon console" }
          : verb === "approve" ? { comment: "Approved from dsh-archon console" }
            : undefined;
        writeStore({ busy: { kind: "run-" + verb, label: label } });
        postJson("/workflows/runs/" + encodeURIComponent(run.id) + "/" + verb, body)
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

      function launchWorkflow() {
        if (store.busy) return;
        var name = s.launchWorkflow;
        if (!name) { patch({ notice: "Pick a workflow first." }); return; }
        writeStore({ busy: { kind: "launch", label: "Launching" } });
        var payload = { message: s.launchMessage || "Run " + name + " from dsh-archon console" };
        postJson("/workflows/" + encodeURIComponent(name) + "/run", payload)
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
          es = new EventSource(SSE);
          var timer = null;
          function onEvent() {
            if (timer) return;
            timer = setTimeout(function () {
              timer = null;
              loadAll();
            }, 400);
          }
          es.addEventListener("workflow_status", onEvent);
          es.addEventListener("dag_node", onEvent);
        } catch (e) {
          // EventSource failure is non-fatal; list views still load via REST.
        }
        return function () { if (es) es.close(); };
        // mount-only; loadAll reads current state via patch only
      }, []);

      // ---- chat helpers ------------------------------------------------------

      function loadConversations() {
        getJson("/conversations").catch(function (e) { return { __error: e }; })
          .then(function (convs) {
            patch({ conversations: convs && !convs.__error ? convs : null, chatError: convs && convs.__error ? "conversations unavailable: " + String(convs.__error.message || convs.__error) : "" });
            // Default to the first conversation if none selected.
            set(function (prev) {
              if (prev.activeConvId || !Array.isArray(convs) || convs.length === 0) return prev;
              var first = convs[0];
              return Object.assign({}, prev, { activeConvId: first.platform_conversation_id || first.id });
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
          es = new EventSource(API + "/stream/" + encodeURIComponent(convId));
        } catch (e) { return; }
        chatEsRef = es;
        es.onmessage = function (raw) {
          var data;
          try { data = JSON.parse(raw.data); } catch (e) { return; }
          if (!data || typeof data.type !== "string") return;
          if (data.type === "text") {
            patch({ streaming: true, streamText: data.content || "" });
          } else if (data.type === "tool_call") {
            patch({ streaming: true, streamText: (data.name || "tool") + " …" });
          } else if (data.type === "tool_result") {
            patch({ streamText: "" });
          } else if (data.type === "conversation_lock") {
            if (!data.locked) { set(function (prev) { return Object.assign({}, prev, { streaming: false, streamText: "" }); }); refreshMessages(convId); }
          } else if (data.type === "workflow_status") {
            set(function (prev) {
              var tail = prev.streaming ? "… " + String(data.status || "").toUpperCase() : "";
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
        getJson("/conversations/" + encodeURIComponent(convId) + "/messages?limit=100").catch(function (e) { return { __error: e }; })
          .then(function (rows) {
            if (rows && !rows.__error && Array.isArray(rows)) {
              set(function (prev) {
                var streaming = prev.streaming && prev.streamText ? prev.streamText : "";
                var list = rows.map(function (m) {
                  return { role: m.role === "assistant" ? "assistant" : "user", content: m.content || "" };
                });
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
        postJson("/conversations", codebaseId ? { codebaseId: codebaseId } : {})
          .then(function (res) {
            if (res && res.conversationId) {
              loadConversations();
              selectConversation(res.conversationId);
              patch({ notice: "Conversation " + res.conversationId + " created" });
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
        postJson("/conversations/" + encodeURIComponent(s.activeConvId) + "/message", { message: text })
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

      // ---- render -----------------------------------------------------------

      var notice = s.notice
        ? React.createElement("div", { className: "dsha-notice" }, s.notice)
        : null;

      return React.createElement("div", { className: "dsha-view" },
        React.createElement("div", { className: "dsha-header" },
          React.createElement("div", { className: "dsha-title" }, "Archon"),
          React.createElement("div", { className: "dsha-modes" },
            React.createElement("button", { type: "button", className: "dsha-mode" + (s.mode === "console" ? " dsha-mode-active" : ""), onClick: function () { patch({ mode: "console" }); } }, "Console"),
            React.createElement("button", { type: "button", className: "dsha-mode" + (s.mode === "chat" ? " dsha-mode-active" : ""), onClick: function () { patch({ mode: "chat" }); loadConversations(); } }, "Chat")),
          React.createElement("div", { className: "dsha-sub" }, s.error
            ? React.createElement("span", { className: "dsha-err" }, s.error)
            : renderHealth(s.health))),
        notice,
        s.mode === "chat"
          ? renderChatPane(s, patch, selectConversation, loadConversations, createConversation, sendMessage, openChatStream, refreshMessages)
          : React.createElement("div", { className: "dsha-body" },
            renderLaunchPanel(s, patch, launchWorkflow, store),
            renderSection("Projects", renderCodebases(s.codebases)),
            renderSection("Workflows", renderWorkflows(s.workflows)),
            renderSection("Runs", renderRuns(s.runs, runControl, store))));
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
          var id = c.platform_conversation_id || c.id;
          var label = (c.title ? c.title : (c.id ? String(c.id).slice(0, 8) : id)) + (c.codebase_id ? "" : " (no project)");
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

    function renderHealth(h) {
      if (!h) return React.createElement("span", { className: "dsha-muted" }, "loading server state…");
      return React.createElement("span", null,
        "server ", React.createElement("strong", null, h.status),
        h.version ? React.createElement("span", null, " · v" + h.version) : null,
        Array.isArray(h.activePlatforms) && h.activePlatforms.length
          ? React.createElement("span", null, " · platforms: " + h.activePlatforms.join(", "))
          : null);
    }

    function renderSection(title, body) {
      return React.createElement("div", { className: "dsha-section" },
        React.createElement("h3", { className: "dsha-section-title" }, title),
        body);
    }

    function renderLaunchPanel(s, patch, launchWorkflow, store) {
      var wf = s.workflows && s.workflows.workflows ? s.workflows.workflows : [];
      var options = [React.createElement("option", { key: "", value: "" }, "— pick a workflow —")];
      wf.slice(0, 200).forEach(function (entry) {
        var w = entry.workflow || entry;
        options.push(React.createElement("option", { key: w.name, value: w.name }, w.name + (entry.source ? " [" + entry.source + "]" : "")));
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
            c.repository_url ? React.createElement("span", { className: "dsha-muted" }, " · " + c.repository_url) : null,
            React.createElement("span", { className: "dsha-muted" }, " · " + (c.kind || "repo")));
        }));
    }

    function renderWorkflows(wf) {
      if (wf === null) return React.createElement("p", { className: "dsha-muted" }, "No response.");
      var list = wf.workflows || [];
      if (list.length === 0) return React.createElement("p", { className: "dsha-muted" }, "No workflows discovered.");
      return React.createElement("div", null,
        React.createElement("ul", { className: "dsha-list dsha-wf" },
          list.slice(0, 40).map(function (entry) {
            var w = entry.workflow || entry;
            var name = w.name || "?";
            var desc = (w.description || "").split("\n")[0] || "";
            return React.createElement("li", { key: name },
              React.createElement("span", { className: "dsha-strong" }, name),
              React.createElement("span", { className: "dsha-src" }, " [" + (entry.source || "?") + "]"),
              desc ? React.createElement("div", { className: "dsha-desc" }, desc) : null);
          })),
        list.length > 40 ? React.createElement("p", { className: "dsha-muted" }, "… and " + (list.length - 40) + " more") : null,
        wf.errors ? React.createElement("p", { className: "dsha-err" }, "Discovery warnings: " + wf.errors.length) : null);
    }

    function renderRuns(runs, runControl, store) {
      if (runs === null) return React.createElement("p", { className: "dsha-muted" }, "No response.");
      var list = runs.runs || [];
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
            var controls = controlsForRun(run.status);
            var anyBusy = store.busy !== null;
            return React.createElement("tr", { key: run.id },
              React.createElement("td", { className: "dsha-strong" }, run.workflow_name || "?"),
              React.createElement("td", null,
                React.createElement("span", { className: "dsha-status " + statusClass(run.status) }, run.status + (run.outcome ? runOutcome(run) : ""))),
              React.createElement("td", { className: "dsha-muted" }, timeAgo(run.last_activity_at || run.started_at)),
              React.createElement("td", { className: "dsha-mono" }, String(run.id).slice(0, 8)),
              React.createElement("td", null,
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

    function isUrlish(value) {
      return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(String(value).trim());
    }

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
        getJson("/codebases/" + encodeURIComponent(codebaseId) + "/env")
          .then(function (res) { patch({ keys: Array.isArray(res.keys) ? res.keys : [], loading: false }); })
          .catch(function (e) {
            patch({ error: "env vars unavailable: " + (e && e.message ? e.message : String(e)), loading: false });
          });
      }

      function addKey() {
        var key = p.newKey.trim();
        var value = p.newValue;
        if (!key || p.busy) return;
        patch({ busy: "add", error: "" });
        putJson("/codebases/" + encodeURIComponent(codebaseId) + "/env", { key: key, value: value })
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
        putJson("/codebases/" + encodeURIComponent(codebaseId) + "/env", { key: key, value: p.editValue })
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
        deleteJson("/codebases/" + encodeURIComponent(codebaseId) + "/env/" + encodeURIComponent(key))
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
      if (codebase.default_cwd) meta.push(codebase.default_cwd);
      if (codebase.kind) meta.push(codebase.kind);
      if (codebase.repository_url) meta.push(codebase.repository_url);

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
        conn: null,          // /api/dsh-archon/state -> { archonBaseUrl, reachable, archon }
        health: null,
        config: null,        // GET /config -> { config, database }
        providers: null,     // GET /providers -> [{ id, displayName, effortLevels, ... }]
        codebases: null,     // GET /codebases -> [Codebase]
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
          getJson("/health").catch(function (e) { return { __error: e }; }),
          getJson("/config").catch(function (e) { return { __error: e }; }),
          getJson("/providers").catch(function (e) { return { __error: e }; }),
          getJson("/codebases").catch(function (e) { return { __error: e }; }),
          fetch("/api/dsh-archon/state", { headers: { accept: "application/json" } })
            .then(function (r) { return r.json().catch(function () { return null; }); })
            .catch(function () { return null; }),
        ]).then(function (results) {
          var health = results[0], config = results[1], providers = results[2], codebases = results[3], conn = results[4];
          var error = "";
          if (health && health.__error) {
            error = "Archon unreachable through the DSH relay: " + String(health.__error.message || health.__error);
          } else if (health && health.status !== "ok") {
            error = "Archon health not ok: " + JSON.stringify(health);
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
            var cfg = config.config || {};
            patch({
              draftAssistant: cfg.assistant || "",
              draftAssistants: cloneAssistants(cfg.assistants || {}),
            });
          }
        });
      }

      function loadCodebases() {
        getJson("/codebases").catch(function (e) { return { __error: e }; })
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
        patchJson("/config/assistants", { assistant: s.draftAssistant, assistants: s.draftAssistants })
          .then(function (res) {
            if (res.__httpStatus >= 200 && res.__httpStatus < 300 && res.config) {
              var cfg = res.config;
              patch({
                config: res,
                draftAssistant: cfg.assistant || "",
                draftAssistants: cloneAssistants(cfg.assistants || {}),
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
        var body = isUrlish(value) ? { url: value } : { path: value };
        postJson("/codebases", body)
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
        deleteJson("/codebases/" + encodeURIComponent(id))
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

      var cfgConfig = s.config && s.config.config ? s.config.config : null;
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
      if (cfgConfig) cells.push(kv("Database", s.config ? s.config.database : ""));
      if (h.adapter) cells.push(kv("Adapter", h.adapter));
      if (typeof h.runningWorkflows === "number") cells.push(kv("Running workflows", String(h.runningWorkflows)));
      if (s.conn) cells.push(kv("Relay target", s.conn.archonBaseUrl));

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
      ".dsha-body{flex:1;min-height:0;overflow:auto;padding:4px 14px 24px;box-sizing:border-box}",
      ".dsha-section{margin-top:14px}",
      ".dsha-section-title{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9aa4b2);margin:0 0 6px}",
      ".dsha-launch{display:flex;gap:8px;align-items:center;margin-top:12px;padding:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}",
      ".dsha-input{flex:none;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-base,rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#e6e9ef);font-size:12px;max-width:320px}",
      ".dsha-input-flex{flex:1;min-width:120px;max-width:none}",
      ".dsha-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e9ef);cursor:pointer;font-size:12px;white-space:nowrap}",
      ".dsha-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".dsha-btn:disabled{opacity:.5;cursor:default}",
      ".dsha-btn-primary{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent;color:#fff}",
      ".dsha-btn-danger{color:#fca5a5}",
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
      ctx.slots.inject("sidebar.workspaces.tools", function () {
        return ctx.slots.register(
          { name: "sidebar.workspaces.tools", id: "archon", order: 12, label: "Archon" },
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
