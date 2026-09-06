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

    // ---- sidebar tool -----------------------------------------------------

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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
