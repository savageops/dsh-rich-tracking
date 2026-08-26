/**
 * dsh-rich-tracking — Host half.
 *
 * Owns the progress-scoreboard system on the host plane:
 *  - `tracking_write` — whole-board replacement with evidence-bound percents
 *  - `tracking_checkpoint` — operator-grade git snapshot + frozen rows
 *  - the `tracking` session projection (mission lifetime: NO turn/start reset)
 *  - the periodic refresh reminder (agent/pre-step, steps + output tokens)
 *  - POST /api/rich-tracking/action — pursue/align/dismiss whip (loopback-fenced)
 *
 * Zero runtime dependencies: node builtins + the pure engine only.
 * Cordis discipline (learned in the phase-0 spike): never touch an undeclared
 * ctx property — sessionProjections arrives via deferred ctx.inject().
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { boardView, foldTracking, lastTrackingEvent, nextCheckpointId, nextRevision, overallPercentOf, validateBoard } from './tracking-engine.js'

const API_PREFIX = '/api/rich-tracking'
/** Refresh cadence (design §10.2, operator-decided v1): 8 assistant steps OR 6k output tokens since the last write. */
const REMINDER_STEPS = 8
const REMINDER_OUTPUT_TOKENS = 6_000
/** Read-only git probes die after this; absence is recorded, never blocking (design D4). */
const GIT_TIMEOUT_MS = 1_500
const ACTION_LIMIT = 100_000

export const name = 'dsh-rich-tracking'
export const inject = ['tools', 'webServer', 'agents', 'systemPrompt']

/**
 * Percent-honesty doctrine (design §11): the board is a commitment device —
 * the operator reads it as a lie detector, so every percent names its basis.
 */
const ANNOUNCEMENT = `dsh-rich-tracking plugin installed (progress scoreboard): the macro percent board the operator watches below the todo pill. todo_write stays the micro plan for the CURRENT turn (it resets every turn); tracking_write is the MISSION scoreboard — waves, milestones, multi-turn objectives — and survives across turns until every row is 100 or the operator dismisses the board.
When to create a board: the operator asks for a scoreboard, waves, or progress tracking, or a mission visibly spans many turns (e.g. a multi-wave build plan). Map rows to the plan's real workstreams (3-7 rows ideal, 12 max; e.g. one row per wave).
Write contract: send the ENTIRE board every call — it REPLACES the previous one. percent is an integer 0-100 derived from artifact truth: (acceptance items that hold right now) / (total acceptance items) in the row's owning artifacts — plan checkboxes, landed receipts, verified readbacks. 100 only when every item is checked AND the owning receipt exists. Every row with percent >= 1 MUST carry evidence naming that basis (paths + checked/total, e.g. '.docs/GOAL.md W2 snapshot + .docs/qc/: 9/14 receipts'). A percent without evidence is a fabrication; validation rejects it and the operator reads the board as a lie detector. Keep a row's percent unchanged when its truth did not change. Update the board after material progress, a verified blocker, or when the operator acts on a row (pursue/align land as instructions naming the row).
Checkpoints: when the operator says "take a checkpoint" / "checkpoint", call tracking_checkpoint — the HOST captures git branch/HEAD/dirty state plus the frozen board; never type git facts yourself.
The board re-derives, it never narrates: after the operator presses ALIGN, recompute every percent from the named artifacts before writing again.`

/** Message factory (dsh-llm shape, inlined zero-dep per design D8). */
function createPluginMessage(content, form, summary) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'plugin', plugin: 'dsh-rich-tracking', form, summary },
  })
}

class TrackingError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'TrackingError'
    this.code = code
  }
}

/** Run one read-only git subcommand, bounded; resolve null on any failure. */
function git(args, cwd) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
        resolve(error === null ? String(stdout).trim() : null)
      })
    } catch {
      resolve(null)
    }
  })
}

/** Light probe for writes: branch + head, or null outside a repo / on timeout. */
async function probeGitLight(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  const [branch, head] = await Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd), git(['rev-parse', 'HEAD'], cwd)])
  if (branch === null || head === null) return null
  return { branch, head }
}

/** Full probe for checkpoints: adds a bounded dirty-state summary. */
async function probeGitFull(cwd) {
  const light = await probeGitLight(cwd)
  if (light === null) return null
  const status = await git(['status', '--porcelain'], cwd)
  let dirtyCount = 0
  const dirtySample = []
  if (status !== null && status !== '') {
    const lines = status.split('\n')
    dirtyCount = lines.length
    for (const line of lines) {
      if (dirtySample.length >= 5) break
      const path = line.slice(3).trim()
      if (path !== '') dirtySample.push(path)
    }
  }
  return { ...light, dirtyCount, dirtySample }
}

/** Commits between a prior checkpoint head and the given head (null when unknowable). */
async function commitsAheadOf(prior, head, cwd) {
  if (prior?.git?.head === undefined || head === null) return null
  if (prior.git.head === head) return 0
  const count = await git(['rev-list', '--count', `${prior.git.head}..${head}`], cwd)
  return count === null ? null : Number(count)
}

/** The tracking_write tool (design §6.1). */
function trackingWriteTool() {
  const rowSchema = {
    type: 'object',
    required: ['id', 'label', 'percent'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: "Stable short ascii slug for this row (e.g. 'w2-fleet'); kept across writes so checkpoints and actions can reference it." },
      label: { type: 'string', description: 'Row name shown on the board, <= 80 chars.' },
      percent: { type: 'integer', minimum: 0, maximum: 100, description: 'Artifact-derived completion percent: (acceptance items that hold now) / (total) in the row evidence artifacts.' },
      status: { type: 'string', enum: ['pending', 'active', 'blocked', 'done'], description: "Optional. Derived when omitted: 100->done, >0->active, 0->pending. 'blocked' requires a note naming the concrete blocker." },
      note: { type: 'string', description: '<= 200 chars: what changed since the last write, or the blocker.' },
      evidence: { type: 'string', description: "<= 300 chars: the artifact basis — owning plan/receipt paths plus checked/total (e.g. '.docs/GOAL.md W2 snapshot + .docs/qc/: 9/14 receipts'). REQUIRED when percent >= 1." },
    },
  }
  return {
    name: 'tracking_write',
    description: "Record and update the session's percent-progress scoreboard (the macro tracking board the operator watches above the chat input; todo_write stays the micro plan for the current turn). Send the ENTIRE board every call — it REPLACES the previous board. Rows: 1-12 (aim 3-7). percent is an integer 0-100 derived from artifact truth: the fraction of that row's acceptance items (plan checkboxes, landed receipts, verified boxes) that hold right now — never an impression. Every row with percent >= 1 MUST carry evidence naming that basis (paths + checked/total). percent 100 requires every acceptance item checked AND the owning receipt to exist. A row at 100 dims but stays visible until every row is 100. Calling this after a dismissal re-opens the board.",
    parameters: {
      type: 'object',
      required: ['rows'],
      additionalProperties: false,
      properties: {
        rows: { type: 'array', minItems: 1, maxItems: 12, items: rowSchema },
        note: { type: 'string', description: '<= 200 chars board-level note (what this write changed).' },
      },
    },
    output: {
      // ctx.tools.register enforces output { schema, render } and validates
      // every result against schema (dsh-tools subset: no minimum/maximum).
      schema: {
        type: 'object',
        required: ['rows', 'overallPercent', 'counts', 'revision', 'git'],
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'label', 'percent', 'status'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                percent: { type: 'integer' },
                status: { type: 'string', enum: ['pending', 'active', 'blocked', 'done'] },
                note: { oneOf: [{ type: 'null' }, { type: 'string' }] },
                evidence: { oneOf: [{ type: 'null' }, { type: 'string' }] },
              },
            },
          },
          overallPercent: { type: 'integer' },
          counts: {
            type: 'object',
            required: ['done', 'active', 'blocked', 'pending'],
            properties: {
              done: { type: 'integer' },
              active: { type: 'integer' },
              blocked: { type: 'integer' },
              pending: { type: 'integer' },
            },
          },
          revision: { type: 'integer' },
          git: {
            oneOf: [
              { type: 'null' },
              { type: 'object', required: ['branch', 'head'], properties: { branch: { type: 'string' }, head: { type: 'string' } } },
            ],
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Tracking board r${value.revision}: ${value.counts.done}/${value.rows.length} rows done, ${value.overallPercent}% overall` + (value.git !== null ? ` · ${value.git.branch}@${value.git.head.slice(0, 7)}` : ''),
      }],
    },
    async execute(args, exec) {
      const check = validateBoard(args)
      if (check.ok === false) throw new TrackingError(`invalid tracking board: ${check.errors.join('; ')}`, 'TRACKING_BAD_BOARD')
      if (exec.agent === undefined) throw new TrackingError('tracking_write requires an owning agent session', 'TRACKING_NO_AGENT')
      const session = exec.agent.session
      const cwd = session.header?.cwd
      const gitState = await probeGitLight(cwd)
      const revision = nextRevision(session.events)
      const lastCheckpoint = lastTrackingEvent(session.events, 'tracking/checkpoint')?.data ?? null
      const ahead = await commitsAheadOf(lastCheckpoint, gitState?.head ?? null, cwd)
      session.append('tracking/write', { revision, rows: check.board.rows, note: check.board.note, git: gitState, commitsAhead: ahead, at: Date.now() })
      return {
        rows: check.board.rows,
        overallPercent: overallPercentOf(check.board.rows),
        counts: {
          done: check.board.rows.filter((row) => row.status === 'done').length,
          active: check.board.rows.filter((row) => row.status === 'active').length,
          blocked: check.board.rows.filter((row) => row.status === 'blocked').length,
          pending: check.board.rows.filter((row) => row.status === 'pending').length,
        },
        revision,
        git: gitState,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update tracking board', kind: 'other', rawInput: args.rows }),
  }
}

/** The tracking_checkpoint tool (design §6.2). */
function trackingCheckpointTool() {
  return {
    name: 'tracking_checkpoint',
    description: "Snapshot the current moment as a tracking checkpoint: the host captures git branch, HEAD, and a dirty-state summary plus the board's current rows, and the board UI shows before/after progress evidence. Call it when the operator asks to 'take a checkpoint' / 'checkpoint', or at a milestone worth before/after evidence (a wave closing, a big migration starting). Returns the checkpoint id (cp-<n>).",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: "Optional short milestone name (<= 60 chars), e.g. 'eu02 rebuild pinned'." },
      },
    },
    output: {
      // Same register contract as tracking_write: the mandatory result schema
      // (probeGitFull's shape: branch/head plus bounded dirty-state summary).
      schema: {
        type: 'object',
        required: ['id', 'label', 'git', 'boardPercent', 'rows'],
        properties: {
          id: { type: 'string' },
          label: { oneOf: [{ type: 'null' }, { type: 'string' }] },
          git: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['branch', 'head', 'dirtyCount', 'dirtySample'],
                properties: {
                  branch: { type: 'string' },
                  head: { type: 'string' },
                  dirtyCount: { type: 'integer' },
                  dirtySample: { type: 'array', items: { type: 'string' } },
                },
              },
            ],
          },
          boardPercent: { type: 'integer' },
          rows: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.git !== null
          ? `Checkpoint ${value.id}${value.label !== null ? ` (${value.label})` : ''} @ ${value.git.branch}@${value.git.head.slice(0, 7)}${value.git.dirtyCount > 0 ? ` (${value.git.dirtyCount} dirty)` : ' (clean)'} — board ${value.boardPercent}%`
          : `Checkpoint ${value.id}${value.label !== null ? ` (${value.label})` : ''} (git state unavailable) — board ${value.boardPercent}%`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new TrackingError('tracking_checkpoint requires an owning agent session', 'TRACKING_NO_AGENT')
      const session = exec.agent.session
      const label = typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim().slice(0, 60) : null
      const gitState = await probeGitFull(session.header?.cwd)
      const rows = lastTrackingEvent(session.events, 'tracking/write')?.data.rows ?? []
      const prior = lastTrackingEvent(session.events, 'tracking/checkpoint')?.data ?? null
      const commitsSincePrior = await commitsAheadOf(prior, gitState?.head ?? null, session.header?.cwd)
      const id = nextCheckpointId(session.events)
      session.append('tracking/checkpoint', { id, label, git: gitState, rows, commitsSincePrior, at: Date.now() })
      return { id, label, git: gitState, boardPercent: overallPercentOf(rows), rows: rows.length }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Take tracking checkpoint', kind: 'other', rawInput: args.label ?? '' }),
  }
}

/** Instruction texts (design §8.3, exact copy). */
function instructionFor(kind, view, rowId) {
  if (kind === 'pursue') {
    const row = view?.rows.find((entry) => entry.id === rowId) ?? view?.rows[0]
    if (row === undefined) return null
    return `[rich-tracking | pursue] The operator pressed PURSUE on tracking row "${row.label}" (${row.percent}%, ${row.status}). Make this row the focus of your next work: if it never started, start it now; if it stalled or the session was interrupted, resume it. Read the row's evidence artifacts for the remaining acceptance items, set your todo_write list to those concrete steps, and call tracking_write with refreshed percents after material progress or a verified blocker.`
  }
  if (kind === 'align') {
    const scoped = rowId !== undefined && rowId !== null ? ` on row "${view?.rows.find((entry) => entry.id === rowId)?.label ?? rowId}"` : ''
    return `[rich-tracking | align] The operator pressed ALIGN${scoped}. Re-derive the board from artifact truth: read each row's evidence artifacts (plan snapshots, receipts, acceptance boxes), recompute percent as checked/total — never from impression — then call tracking_write with the corrected rows and re-align your todo_write list to the remaining work. Drop rows whose owning artifacts prove them obsolete; add rows the plan owns but the board misses.`
  }
  if (kind === 'checkpoint-request') {
    return '[rich-tracking | checkpoint] The operator requested a checkpoint. Call tracking_checkpoint now (a short label naming the milestone when one fits), then continue the current work.'
  }
  if (kind === 'dismiss-row') {
    const row = view?.rows.find((entry) => entry.id === rowId)
    if (row === undefined) return null
    return `[rich-tracking | dismiss] The operator dismissed row "${row.label}" from the tracking board. Omit it from your next tracking_write unless its owning artifact re-opens it.`
  }
  if (kind === 'dismiss') {
    return '[rich-tracking | dismiss] The operator dismissed the tracking board. Stop updating it; do not call tracking_write unless the operator asks to re-open tracking.'
  }
  return null
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Read a bounded JSON request body. */
async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? undefined : JSON.parse(raw)
}

/** Route fence (exemplar posture): loopback socket + browser same-origin marker. */
function guard(req, res) {
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const site = req.headers['sec-fetch-site']
  const browser = site === 'same-origin' || typeof req.headers.origin === 'string'
  if (!loopback || !browser) writeJson(res, 403, { ok: false, error: 'forbidden' })
  return loopback && browser
}

/** The refresh loop (design §10): log-derived counters + one reminder per turn. */
function installRefreshReminder(ctx) {
  /** Per-session runtime: folded projection STATE (not the view — folds chain), staleness counters, turn cap. */
  const runtime = new WeakMap()

  const runtimeOf = (session) => {
    let entry = runtime.get(session)
    if (entry === undefined) {
      // First touch folds the FULL log: constructor seeds (resume/fork) never
      // fire session/event, so incremental-only would miss pre-existing boards.
      let state = null
      for (const event of session.events) state = foldTracking(state, event)
      entry = { state, steps: 0, outputTokens: 0, remindedThisTurn: false }
      runtime.set(session, entry)
    }
    return entry
  }

  ctx.on('session/event', (session, event) => {
    let entry
    try { entry = runtimeOf(session) } catch { return }
    if (event.type === 'tracking/write' || event.type === 'tracking/checkpoint' || event.type === 'tracking/decision') {
      entry.state = foldTracking(entry.state, event)
      if (event.type === 'tracking/write') {
        entry.steps = 0
        entry.outputTokens = 0
      }
      return
    }
    if (event.type === 'turn/start') {
      entry.remindedThisTurn = false
      return
    }
    if (event.type === 'assistant/message') {
      entry.steps += 1
      entry.outputTokens += Number(event.data?.usage?.outputTokens ?? 0)
    }
  })

  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    return (async () => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      let entry
      try { entry = runtimeOf(agent.session) } catch { return decision }
      const view = boardView(entry.state)
      if (view === null || view.present !== true) return decision // no board, or dismissed
      if (view.allDone === true) return decision // nothing to refresh
      if (entry.remindedThisTurn === true) return decision // one per turn
      if (entry.steps < REMINDER_STEPS && entry.outputTokens < REMINDER_OUTPUT_TOKENS) return decision
      entry.remindedThisTurn = true
      const rows = view.rows.map((row) => `${row.label} ${row.percent}%`).join('; ')
      const message = createPluginMessage(
        `<tracking-refresh> The tracking board is stale: ${entry.steps} assistant steps and ~${entry.outputTokens} output tokens since the last tracking_write. Current rows: ${rows}. Re-derive percents from artifact truth (the row evidence fields name the owners: plan snapshots, receipts, acceptance boxes) and call tracking_write with the corrected board. Keep a row's percent unchanged when its truth did not change. Do not mention this reminder to the user.`,
        'notice',
        'tracking refresh',
      )
      return { ...decision, messages: [...decision.messages, message] }
    })()
  })
}

export function apply(ctx) {
  // Projection (deferred, the todo tool's pattern). viewSchema is consumed as
  // `.parse()` — a zero-dep identity schema satisfies the wire contract.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'tracking',
      stateSchema: { parse: (value) => value },
      init: () => null,
      apply: foldTracking,
      wire: { viewSchema: { parse: (value) => value }, view: boardView },
      stateVersion: 1,
    })
  })

  ctx.systemPrompt.section({ name: 'plugin:rich-tracking', order: 210, text: ANNOUNCEMENT })
  ctx.tools.register(trackingWriteTool())
  ctx.tools.register(trackingCheckpointTool())
  installRefreshReminder(ctx)

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/action`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!guard(req, res)) return
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { writeJson(res, 415, { ok: false, error: 'json-required' }); return }
        let body
        try { body = await readJsonBody(req, ACTION_LIMIT) } catch (error) {
          writeJson(res, error?.message === 'body-too-large' ? 413 : 400, { ok: false, error: error?.message ?? 'bad-request' })
          return
        }
        if (typeof body !== 'object' || body === null || typeof body.sessionId !== 'string' || typeof body.kind !== 'string') {
          writeJson(res, 400, { ok: false, error: 'invalid-action' })
          return
        }
        const kinds = new Set(['pursue', 'align', 'dismiss', 'dismiss-row', 'checkpoint-request'])
        if (kinds.has(body.kind) === false) { writeJson(res, 400, { ok: false, error: 'unknown-action' }); return }

        const agent = ctx.agents.get(body.sessionId)
        if (agent === undefined) { writeJson(res, 409, { ok: false, error: 'session-offline' }); return }

        // Fold the current board for instruction templating.
        let state = null
        for (const event of agent.session.events) state = foldTracking(state, event)
        const view = boardView(state)

        const instruction = instructionFor(body.kind, view, body.rowId)
        if (instruction === null) { writeJson(res, 400, { ok: false, error: 'row-not-found' }); return }

        agent.session.append('tracking/decision', { kind: body.kind, rowId: body.rowId ?? null, instruction, at: Date.now() })

        const whip = body.kind === 'pursue' || body.kind === 'align' || body.kind === 'checkpoint-request'
        if (whip === true) {
          const message = createPluginMessage(instruction, 'steer', `${body.kind}${body.rowId !== undefined && body.rowId !== null ? ` ${body.rowId}` : ''}`)
          if (agent.status === 'running') agent.steer(message)
          else agent.followup(message)
          writeJson(res, 200, { ok: true, delivered: agent.status === 'running' ? 'steer' : 'followup' })
          return
        }
        agent.inject(createPluginMessage(instruction, 'notice', `dismiss${body.kind === 'dismiss-row' ? ` ${body.rowId ?? ''}`.trimEnd() : ''}`))
        writeJson(res, 200, { ok: true, delivered: 'inject' })
      },
    })
    return dispose
  }, 'rich-tracking: action route')
}
