/**
 * dsh-archon — pure Workflow Studio logic (no DOM, no fetch, no React).
 *
 * The Studio edits Archon workflow definitions as a node graph. Everything that
 * is a deterministic transform lives here so it can be unit-tested from Node
 * (`tests/studio-core.mjs`) and shipped inside the single-file browser bundle:
 * `lib/client.js` embeds a verbatim copy between the `// >>> studio-core` and
 * `// <<< studio-core` markers with the `export ` keywords stripped, refreshed
 * by `node scripts/sync-client-surface.mjs` and guarded by
 * `tests/surface-mirror.mjs` — the same mechanism `lib/archon-surface.js` uses.
 *
 * The one contract this module exists for: **`GET /api/workflows/{name}` returns
 * NORMALIZED nodes** (the engine's transform output: `kind:'agent'` with a
 * `source` object, `kind:'exec'` with `script`/`runtime`, `kind:'gate'`, …)
 * while **`POST /api/workflows/validate` and `PUT /api/workflows/{name}` require
 * AUTHORING nodes** (the YAML mode keys: `prompt:`, `command:`, `bash:`,
 * `script:`, `loop:`, `approval:`, `wait:`, `cancel:`). `importDefinition`
 * inverts the engine transform into an editable model; `exportDefinition`
 * rebuilds the authoring form. A node kind with no authoring inversion is kept
 * as an `opaque` node: its body rides through untouched so workflows using
 * `include:`, `workflow:` or `loop_group:` stay openable and saveable.
 *
 * Model shape:
 *   { name, description, meta, nodes: [{ id, variant, base, data }] }
 * `base` holds the graph/scheduling fields shared by every variant (`depends_on`,
 * `when`, `model`, `hooks`, …) verbatim; `data` holds the authoring mode keys for
 * the variant. Export emits `{ id, ...base, ...data }` in that order, so the YAML
 * the server writes leads with `id:`.
 *
 * Keep this file to plain ES5-style functions and `var` so the embedded copy
 * runs unchanged inside the browser factory: no imports, no arrow functions, no
 * template literals, no object spread, `export ` only as a leading keyword.
 *
 * @module dsh-archon/studio-core
 */

/** The node variants the Studio can author. Anything else imports as `opaque`. */
export var STUDIO_VARIANTS = ["prompt", "command", "bash", "script", "loop", "approval", "wait", "cancel"];

/** Canvas geometry, shared by the layout function and the canvas renderer. */
export var NODE_W = 180;
export var NODE_H = 80;

/**
 * Per-variant label and the authoring body a freshly added node starts with.
 * `defaults()` returns a new object every call — never share one between nodes.
 */
export var VARIANT_INFO = {
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
export var BASE_FIELD_KEYS = [
  "depends_on", "when", "trigger_rule", "model", "provider", "context", "output_format",
  "allowed_tools", "denied_tools", "idle_timeout", "retry", "hooks", "mcp", "skills",
  "agents", "effort", "maxBudgetUsd", "systemPrompt", "fallbackModel", "betas", "sandbox",
  "always_run", "persist_session", "output_type",
];

/** Base fields the inspector exposes directly; everything else is preserved silently. */
export var EDITABLE_BASE_KEYS = ["when", "trigger_rule", "provider", "model", "persist_session"];

/** Variants whose AI fields (provider/model/persist_session) the engine honors. */
export var AI_VARIANTS = ["prompt", "command", "loop"];

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
export function cloneValue(value) {
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
export function detectAuthoringVariant(node) {
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
export function importDefinition(definition) {
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
export function exportNode(node) {
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
export function exportDefinition(model) {
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
export function validateModel(model) {
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
export function blockingIssues(issues) {
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
export function serializeYamlPreview(definition) {
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
export function edgeIdFor(source, target) {
  return source + "->" + target;
}

/**
 * Model -> canvas edges. One edge per resolvable `depends_on` entry; entries
 * naming an unknown node are left in the model (and reported by `validateModel`)
 * but not drawn. `dashed` marks an edge into a `when`-gated node.
 */
export function edgesFromModel(model) {
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
export function layoutGraph(nodes, edges) {
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
export function findNodeIndex(model, id) {
  var nodes = model && Array.isArray(model.nodes) ? model.nodes : [];
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return i;
  }
  return -1;
}

/** A node id of the shape `<variant>-<n>` that no node in `model` uses yet. */
export function uniqueNodeId(variant, model) {
  var taken = Object.create(null);
  var nodes = model && Array.isArray(model.nodes) ? model.nodes : [];
  for (var i = 0; i < nodes.length; i++) taken[nodes[i].id] = true;
  var n = 1;
  while (taken[variant + "-" + n]) n += 1;
  return variant + "-" + n;
}

/** Append a node of `variant` with the registry defaults. */
export function addNode(model, variant) {
  var next = cloneModel(model);
  var info = VARIANT_INFO[variant] || VARIANT_INFO.prompt;
  var node = { id: uniqueNodeId(variant, next), variant: variant, base: {}, data: info.defaults() };
  next.nodes = next.nodes.concat([node]);
  return { model: next, node: node };
}

/** Replace one node's fields through `change(node)`, which returns the new node. */
export function updateNode(model, id, change) {
  var next = cloneModel(model);
  var index = findNodeIndex(next, id);
  if (index === -1) return next;
  next.nodes = next.nodes.slice();
  next.nodes[index] = change(next.nodes[index]);
  return next;
}

/** Set (or, with `value === undefined`, delete) one key of a node's `base`. */
export function setBaseField(model, id, key, value) {
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
export function setDataField(model, id, path, value) {
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
export function renameNode(model, from, to) {
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
export function removeNode(model, id) {
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
export function connectNodes(model, source, target) {
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
export function disconnectNodes(model, source, target) {
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
export function isValidWorkflowName(name) {
  var text = typeof name === "string" ? name : "";
  if (text === "" || text.charAt(0) === ".") return false;
  if (text.indexOf("/") !== -1 || text.indexOf("\\") !== -1 || text.indexOf("..") !== -1) return false;
  return true;
}

/**
 * Whether a rename can go ahead. `PUT` silently overwrites a colliding file and
 * never returns 409, so the collision guard has to live here.
 */
export function planRename(from, to, existingNames) {
  if (!isValidWorkflowName(to)) return { ok: false, reason: "invalid-name" };
  if (to === from) return { ok: false, reason: "noop" };
  var names = Array.isArray(existingNames) ? existingNames : [];
  if (names.indexOf(to) !== -1) return { ok: false, reason: "collision" };
  return { ok: true };
}

/** Why a name was refused, in words a user can act on. */
export function renameReasonMessage(reason, name) {
  if (reason === "invalid-name") {
    return "'" + name + "' is not a valid workflow name (no '/', '\\' or '..', and it cannot start with '.').";
  }
  if (reason === "collision") return "A workflow named '" + name + "' already exists here.";
  if (reason === "noop") return "That is already the workflow's name.";
  return "That name cannot be used.";
}

/** The smallest definition the server accepts, in authoring shape. */
export function newWorkflowSeed(name) {
  return {
    name: name,
    description: "New workflow.",
    nodes: [{ id: "step-1", prompt: "Describe what this step should do." }],
  };
}

/** Bundled workflows are read-only; everything else edits in place. */
export function isReadOnlySource(source) {
  return source === "bundled";
}

/** Where a save writes: a global workflow stays global, everything else is a project file. */
export function saveTargetFor(source) {
  return source === "global" ? "global" : "project";
}

/**
 * The issues a rejected `POST /workflows/validate` should show. The response is
 * HTTP 200 with `valid:false`, and its `errors` array can be empty — so this
 * always yields at least one issue rather than silently clearing the panel.
 */
export function serverIssues(errors) {
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
export function nodeSummary(node) {
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
export function preservedBaseKeys(node) {
  var base = node && isObject(node.base) ? node.base : {};
  return Object.keys(base).filter(function (key) {
    return key !== "depends_on" && EDITABLE_BASE_KEYS.indexOf(key) === -1;
  });
}
