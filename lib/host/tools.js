/**
 * dsh-archon — agent-facing Archon tools (host).
 *
 * Registers a small toolset so the DSH model can inspect and drive the Archon
 * engine from normal chat, all running inside the dsh process against the
 * Archon REST API (lib/host/archon-client.js):
 *
 *   archon_status       — server health + version + active platforms
 *   archon_workflows    — list discoverable workflows (project or bundled)
 *   archon_runs         — list recent workflow runs (status filter)
 *   archon_run          — launch a workflow (message; optional codebase)
 *   archon_control      — approve/reject/resume/cancel/abandon a run
 *
 * Tools are plain `ctx.tools.register` descriptors (same contract as
 * dsh-tmux-terminal) so the module stays dependency-free and degrades when the
 * tools service is absent.
 *
 * @module dsh-archon/host/tools
 */

import {
  health,
  listCodebases,
  listWorkflows,
  listRuns,
  launchRun,
  runControl,
} from './archon-client.js'
import {
  RUN_CONTROL_VERBS,
  codebaseMatches,
  normalizeCodebase,
  normalizeHealth,
  normalizeRunList,
  normalizeWorkflowList,
  runControlPayload,
} from '../archon-surface.js'
import { checkCompatibility } from './compat.js'

/** Flat JSON-Schema object root for the raw tool registry. */
function parameterSchema(fields) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(fields)) {
    const { required: isRequired, ...schema } = field
    properties[key] = schema
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

const textOutput = {
  schema: { type: 'string' },
  render: (value) => [{ type: 'text', text: String(value) }],
}

const CONTROL_VERBS = RUN_CONTROL_VERBS

/**
 * Register the Archon tools.
 * @param ctx - cordis context with a `tools` service.
 * @returns true when registration happened, false when the service is absent.
 */
export function registerTools(ctx) {
  const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null
  if (!tools || typeof tools.register !== 'function') return false

  tools.register({
    name: 'archon_status',
    description:
      'Report whether the Archon workflow engine is reachable, its version, status, active platforms, and whether '
      + 'that version is inside the range this plugin was tested against. No arguments. Use before '
      + 'archon_workflows/archon_runs/archon_run so you know the server is up.',
    parameters: parameterSchema({}),
    output: textOutput,
    async execute() {
      const result = normalizeHealth(await health())
      const compat = checkCompatibility(result.version)
      return JSON.stringify({
        reachable: true,
        status: result.status,
        version: result.version,
        activePlatforms: result.activePlatforms,
        runningWorkflows: result.runningWorkflows,
        compatible: compat.compatible,
        compatibility: compat.reason,
      }, null, 2)
    },
  })

  tools.register({
    name: 'archon_workflows',
    description:
      'List workflows the Archon engine can run. Optional `cwd` is an absolute path of a registered project '
      + '(codebase) whose .archon/workflows should be discovered; omit it to list bundled + home-scope defaults.',
    parameters: parameterSchema({
      cwd: { type: 'string', description: 'Absolute project path (registered codebase); omit for bundled defaults' },
    }),
    output: textOutput,
    async execute(args) {
      const list = normalizeWorkflowList(await listWorkflows((args && args.cwd) || undefined)).entries
      return JSON.stringify({ count: list.length, workflows: list }, null, 2)
    },
  })

  tools.register({
    name: 'archon_runs',
    description:
      'List recent Archon workflow runs. Optional `status` filters '
      + '(pending|running|paused|completed|failed|cancelled); `limit` caps rows (default 20).',
    parameters: parameterSchema({
      status: { type: 'string', enum: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'] },
      limit: { type: 'number', description: 'max rows (1-200), default 20' },
    }),
    output: textOutput,
    async execute(args) {
      const result = await listRuns({
        status: (args && args.status) || undefined,
        limit: Number((args && args.limit) || 20),
      })
      const runs = normalizeRunList(result).map((run) => ({
        id: run.id,
        workflow: run.workflow,
        status: run.status,
        outcome: run.outcome,
        started: run.startedAt,
        lastActivity: run.lastActivityAt,
      }))
      return JSON.stringify({ count: runs.length, runs }, null, 2)
    },
  })

  tools.register({
    name: 'archon_run',
    description:
      'Launch an Archon workflow run. `name` must be a discovered workflow (see archon_workflows). '
      + '`message` is the task description. Optional `codebase` is an absolute registered-project path so the '
      + 'run has project context (worktree isolation). Returns the dispatch acknowledgement.',
    parameters: parameterSchema({
      name: { type: 'string', required: true, description: 'workflow name, e.g. archon-assist' },
      message: { type: 'string', required: true, description: 'task description for the run' },
      codebase: { type: 'string', description: 'absolute registered project path for project context' },
    }),
    output: textOutput,
    async execute(args) {
      const name = (args && args.name || '').trim()
      const message = (args && args.message || '').trim()
      if (!name) throw new Error('archon_run requires a workflow name')
      if (!message) throw new Error('archon_run requires a message (the task for the run)')
      // Optional project context: map a registered-project path to its codebase
      // id so the created web conversation is bound to the right project.
      let codebaseId
      const codebasePath = (args && args.codebase || '').trim()
      if (codebasePath) {
        const codebases = await listCodebases()
        const match = (Array.isArray(codebases) ? codebases : []).map(normalizeCodebase)
          .find((cb) => codebaseMatches(cb, codebasePath))
        if (!match) {
          throw new Error(`archon_run: "${codebasePath}" is not a registered project (see codebases list; register in Archon first)`)
        }
        codebaseId = match.id
      }
      const result = await launchRun(name, { message, codebaseId })
      return JSON.stringify(result, null, 2)
    },
  })

  tools.register({
    name: 'archon_control',
    description:
      'Control an Archon workflow run by id (see archon_runs). `action` is one of: '
      + 'approve, reject, resume, cancel, abandon. `comment` (approve) and `reason` (reject) are optional text.',
    parameters: parameterSchema({
      runId: { type: 'string', required: true, description: 'the run id' },
      action: { type: 'string', required: true, enum: CONTROL_VERBS },
      comment: { type: 'string', description: 'approval comment (approve only)' },
      reason: { type: 'string', description: 'rejection reason (reject only)' },
    }),
    output: textOutput,
    async execute(args) {
      const runId = (args && args.runId || '').trim()
      const action = (args && args.action || '').trim()
      if (!runId) throw new Error('archon_control requires runId')
      if (!CONTROL_VERBS.includes(action)) {
        throw new Error(`archon_control action must be one of ${CONTROL_VERBS.join(', ')}`)
      }
      const payload = runControlPayload(action, action === 'reject' ? args && args.reason : args && args.comment)
      const result = await runControl(runId, action, payload)
      return JSON.stringify({ ok: true, action, runId, ...result }, null, 2)
    },
  })

  return true
}
