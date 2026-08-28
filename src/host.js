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
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { boardView, foldTracking, lastTrackingEvent, ledgerContext, nextCheckpointId, nextRevision, overallPercentOf, validateBoard } from './tracking-engine.js'

const API_PREFIX = '/api/rich-tracking'
/** Refresh cadence (design §10.2, operator-decided v1): 8 assistant steps OR 6k output tokens since the last write. */
const REMINDER_STEPS = 8
const REMINDER_OUTPUT_TOKENS = 6_000
/** Read-only git probes die after this; absence is recorded, never blocking (design D4). */
const GIT_TIMEOUT_MS = 1_500
const ACTION_LIMIT = 100_000

/**
 * A child session's OWN events start at its seed boundary: fork children are
 * seeded with the parent's completed-turn log INCLUDING its tracking events,
 * so folding from zero would hand the child the parent's board — reminders
 * and the play-mode engage loop would fire inside delegated children, and the
 * Tracks scanner would list 76 duplicate parent boards (measured on this
 * deployment). The child's board is what the CHILD writes.
 */
function seedBoundary(session) {
  const header = session?.header
  const value = header?.seedLength
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** The session's own (post-seed) events, as a bounded array. */
function ownEvents(session) {
  const events = Array.isArray(session?.events) ? session.events : []
  const boundary = seedBoundary(session)
  return boundary > 0 ? events.slice(boundary) : events
}

// ── Tracks view: every board, every workspace ────────────────────────────────
/** Sessions root (same layout the GUI uses: --slug--/<sessionId>/session.jsonl.zstd). */
const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
/** Per-file scan cache: mtime+size keyed, so repeat opens only read changed logs. */
const tracksCache = new Map()
/** Scan budget per request: newest logs first; the rest catch up on later opens. */
const TRACKS_BUDGET_MS = 8_000
/** Cache TTL: a live session's log keeps changing; within this window the cached fold is served (review P2). */
const TRACKS_CACHE_TTL_MS = 3_000
/** Skip logs whose compressed size implies crossing the execFile maxBuffer cliff (review P2). */
const TRACKS_MAX_COMPRESSED_BYTES = 48 * 1024 * 1024
/** Per-file in-flight scans, so concurrent /tracks requests don't double-zstd (review P2). */
const tracksInFlight = new Map()
const ZSTD_MAX_BUFFER = 192 * 1024 * 1024

const execZstd = (file) => new Promise((resolve) => {
  execFile('zstd', ['-dc', file], { timeout: 4_000, maxBuffer: ZSTD_MAX_BUFFER }, (error, stdout) => {
    resolve(error !== null ? null : stdout)
  })
})

/**
 * Fold one session log into a Tracks summary. Returns null when the session
 * never wrote a board (the overwhelming majority) — those cache as null too.
 */
async function scanSessionFile(file) {
  const text = await execZstd(file)
  if (text === null) return null
  let state = null
  let cwd = null
  let title = null
  let boundary = 0
  for (const line of text.split('\n')) {
    if (line === '' || line.length > 2_000_000) continue
    // Cheap pre-filter: only tracking/session/title lines matter; the log is
    // overwhelmingly chunk traffic that would otherwise pay a JSON.parse tax.
    if (line.charCodeAt(0) !== 123) continue
    if (line.includes('"tracking/') === false && line.includes('"session/title"') === false && line.includes('"type":"session"') === false) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const type = event?.type
    if (type === 'session') {
      // The session event is FLAT (cwd at top level); tolerate a data wrapper too.
      const flat = typeof event.cwd === 'string' ? event.cwd : undefined
      const wrapped = typeof event.data?.cwd === 'string' ? event.data.cwd : undefined
      cwd = flat ?? wrapped ?? cwd
      boundary = Number.isSafeInteger(event.seedLength) && event.seedLength > 0 ? event.seedLength : 0
    }
    else if (type === 'session/title') { if (typeof event.data?.title === 'string' && event.data.title !== '') title = event.data.title }
    else if (type === 'tracking/write' || type === 'tracking/checkpoint' || type === 'tracking/decision') {
      // Seed boundary: inherited (pre-boundary) tracking events are the PARENT's board.
      if (Number.isSafeInteger(event.seq) && event.seq < boundary) continue
      // Poison-pill guard (review P2): one malformed tracking event must 500 the
      // route forever — wrap the fold so the file caches as boardless instead.
      try { state = foldTracking(state, event) } catch { state = state ?? null }
    }
  }
  let view = null
  try { view = boardView(state) } catch { view = null }
  if (view === null || view.present !== true) return null
  return {
    cwd,
    title,
    revision: view.revision,
    overallPercent: view.overallPercent,
    allDone: view.allDone === true,
    playMode: view.playMode === true,
    rows: view.rows.map((row) => ({
      id: row.id,
      label: row.label,
      percent: row.percent,
      status: row.status,
      items: Array.isArray(row.items) ? { done: row.items.filter((item) => item.done === true).length, total: row.items.length } : null,
    })),
    lastWriteAt: view.updatedAt ?? null,
  }
}

/** All boards across all workspaces, newest activity first. */
async function scanTracks(ctx, budgetMs = TRACKS_BUDGET_MS) {
  const startedAt = Date.now()
  const workspaces = []
  try {
    for (const entry of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('--') && entry.name.endsWith('--')) workspaces.push(entry.name.slice(2, -2))
    }
  } catch { return { boards: [], scanned: 0, total: 0, workspaces: [] } }
  const files = []
  for (const slugName of workspaces) {
    const dir = join(SESSIONS_ROOT, `--${slugName}--`)
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() === false) continue
        const file = join(dir, entry.name, 'session.jsonl.zstd')
        try {
          const stats = statSync(file)
          // slug carries the display name (delimiters stripped, review P3)
          files.push({ file, slug: slugName, sessionId: entry.name, mtimeMs: stats.mtimeMs, size: stats.size })
        } catch { /* no log for this session dir */ }
      }
    } catch { /* unreadable workspace dir */ }
  }
  // Newest first: live/recent boards surface within the budget; the tail catches up via cache.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  // Evict cache entries for sessions that no longer exist on disk (review P2).
  const livePaths = new Set(files.map((candidate) => candidate.file))
  for (const key of tracksCache.keys()) if (livePaths.has(key) === false) tracksCache.delete(key)

  const boards = []
  let scanned = 0
  for (const candidate of files) {
    const cached = tracksCache.get(candidate.file)
    const exact = cached !== undefined && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size
    // TTL tolerance: a live session's stat changes on every append; serving the
    // sub-TTL fold bounds hot-log rescans to one per window.
    const withinTtl = cached !== undefined && Date.now() - (cached.readAt ?? 0) < TRACKS_CACHE_TTL_MS
    if (exact || withinTtl) {
      if (cached.summary !== null) boards.push({ ...cached.summary, slug: candidate.slug, sessionId: candidate.sessionId })
      scanned += 1
      continue
    }
    if (Date.now() - startedAt > budgetMs) break
    if (candidate.size > TRACKS_MAX_COMPRESSED_BYTES) {
      tracksCache.set(candidate.file, { mtimeMs: candidate.mtimeMs, size: candidate.size, summary: null, readAt: Date.now() })
      scanned += 1
      continue
    }
    let pending = tracksInFlight.get(candidate.file)
    if (pending === undefined) {
      pending = scanSessionFile(candidate.file)
      tracksInFlight.set(candidate.file, pending)
      pending.finally(() => tracksInFlight.delete(candidate.file)).catch(() => {})
    }
    const summary = await pending
    tracksCache.set(candidate.file, { mtimeMs: candidate.mtimeMs, size: candidate.size, summary, readAt: Date.now() })
    scanned += 1
    if (summary !== null) boards.push({ ...summary, slug: candidate.slug, sessionId: candidate.sessionId })
  }
  // Liveness: only in-process agents can receive whip actions.
  for (const board of boards) {
    const agent = ctx.agents?.get?.(board.sessionId)
    board.live = agent !== undefined
    board.agentStatus = agent !== undefined ? agent.status : 'offline'
  }
  boards.sort((a, b) => (b.lastWriteAt ?? 0) - (a.lastWriteAt ?? 0) || (b.live === true ? 1 : 0) - (a.live === true ? 1 : 0))
  return { boards, scanned, total: files.length, workspaces }
}

export const name = 'dsh-rich-tracking'
export const inject = ['tools', 'webServer', 'agents', 'systemPrompt', 'sessionEventTypes']

// These records shape the tracking projection and are required for faithful
// history reads. The core persistence guard admits them only while this plugin
// is active and owns the registration.
const TRACKING_EVENT_TYPES = Object.freeze([
  'tracking/write',
  'tracking/checkpoint',
  'tracking/decision',
])

/**
 * Percent-honesty doctrine (design §11): the board is a commitment device —
 * the operator reads it as a lie detector, so every percent names its basis.
 */
const ANNOUNCEMENT = `dsh-rich-tracking plugin installed (progress scoreboard): the macro percent board the operator watches below the todo pill. todo_write stays the micro plan for the CURRENT turn (it resets every turn); tracking_write is the MISSION scoreboard — waves, milestones, multi-turn objectives — and survives across turns until every row is 100 or the operator dismisses the board.
When to create a board: the operator asks for a scoreboard, waves, or progress tracking, or a mission visibly spans many turns (e.g. a multi-wave build plan). Map rows to the plan's real workstreams (3-7 rows ideal, 12 max; e.g. one row per wave).
Write contract: send the ENTIRE board every call — it REPLACES the previous one. percent is an integer 0-100 derived from artifact truth: (acceptance items that hold right now) / (total acceptance items) in the row's owning artifacts — plan checkboxes, landed receipts, verified readbacks. 100 only when every item is checked AND the owning receipt exists. Every row with percent >= 1 MUST carry evidence naming that basis (paths + checked/total, e.g. '.docs/GOAL.md W2 snapshot + .docs/qc/: 9/14 receipts'). A percent without evidence is a fabrication; validation rejects it and the operator reads the board as a lie detector. Rows may carry items — a 1-20 entry acceptance checklist [{label, done}] the operator expands by clicking the row; when items are present, percent must equal round(done/total x 100) (validation rejects a mismatch) and the checklist becomes the row's visible inner progress. Overall completion is item-weighted (each item one unit; itemless rows contribute their percent as one unit). Keep a row's percent unchanged when its truth did not change. Update the board after material progress, a verified blocker, or when the operator acts on a row (pursue/align land as instructions naming the row).
Checkpoints: when the operator says "take a checkpoint" / "checkpoint", call tracking_checkpoint — the HOST captures git branch/HEAD/dirty state plus the frozen board; never type git facts yourself.
Update cadence — living ledger: call tracking_write after EVERY completed task, step, or todo whose artifact truth changed (refreshed percents and item flags), and update the row prose (label, note, evidence, items) whenever the underlying details shift. The board always describes current reality, not a milestone snapshot.
/track: the operator's chat command forces a ledger sync — it injects the full ledger plus this doctrine into your next step; re-derive from artifacts, correct the board, then continue with the work. While a board is live, every user submit also carries a compact board reminder; do not recite it to the user.
Delegation: when the operator presses DELEGATE on a row (or asks to delegate), hand that row to a background subagent with read/write access — self-contained brief (row details, items, evidence, progress), scoped strictly to that row's task and subtasks, and the subagent tracks its own progress with tracking_write in its own session. Fold its receipts back into the row when its report lands.
The board re-derives, it never narrates: after the operator presses ALIGN, recompute every percent from the named artifacts before writing again.`

/** Message factory (dsh-llm shape, inlined zero-dep per design D8). Content is a block array — a plain string renders as per-character unknown blocks. */
function createPluginMessage(text, form, summary) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
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
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        description: 'Optional acceptance checklist (1-20 items) the operator expands by clicking the row: [{ label, done }]. When present, percent MUST equal round(done/total x 100) — validation rejects a mismatch. Items make the row\'s inner progress visible (done items grey out); evidence still names the artifact basis.',
        items: {
          type: 'object',
          required: ['label', 'done'],
          additionalProperties: false,
          properties: {
            label: { type: 'string', description: 'One acceptance item, <= 120 chars (e.g. "engine tests green").' },
            done: { type: 'boolean', description: 'True when this item holds right now.' },
          },
        },
      },
    },
  }
  return {
    name: 'tracking_write',
    description: "Record and update the session's percent-progress scoreboard (the macro tracking board the operator watches above the chat input; todo_write stays the micro plan for the current turn). Send the ENTIRE board every call — it REPLACES the previous board. Rows: 1-12 (aim 3-7). percent is an integer 0-100 derived from artifact truth: the fraction of that row's acceptance items (plan checkboxes, landed receipts, verified boxes) that hold right now — never an impression. Every row with percent >= 1 MUST carry evidence naming that basis (paths + checked/total). percent 100 requires every acceptance item checked AND the owning receipt to exist. A row at 100 dims but stays visible until every row is 100. Rows may carry items — a 1-20 entry acceptance checklist [{label, done}] the operator expands by clicking the row (done items grey out, open items stay readable); when items are present, percent MUST equal round(done/total x 100) and validation rejects a mismatch, so the visible checklist always adds up to the shown percent. Overall completion is item-weighted: each item is one unit, itemless rows contribute their percent as one unit. Calling this after a dismissal re-opens the board.",
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
                items: { type: 'array', items: { type: 'object', required: ['label', 'done'], properties: { label: { type: 'string' }, done: { type: 'boolean' } } } },
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
      // Revision is minted AFTER the await, immediately before the append, so
      // parallel tool calls cannot mint duplicate revisions (review P3).
      const revision = nextRevision(ownEvents(session))
      const lastCheckpoint = lastTrackingEvent(ownEvents(session), 'tracking/checkpoint')?.data ?? null
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
      const rows = lastTrackingEvent(ownEvents(session), 'tracking/write')?.data.rows ?? []
      const prior = lastTrackingEvent(ownEvents(session), 'tracking/checkpoint')?.data ?? null
      const commitsSincePrior = await commitsAheadOf(prior, gitState?.head ?? null, session.header?.cwd)
      const id = nextCheckpointId(ownEvents(session))
      session.append('tracking/checkpoint', { id, label, git: gitState, rows, commitsSincePrior, at: Date.now() })
      return { id, label, git: gitState, boardPercent: overallPercentOf(rows), rows: rows.length }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Take tracking checkpoint', kind: 'other', rawInput: args.label ?? '' }),
  }
}

/** Instruction texts (design §8.3, exact copy). */
function instructionFor(kind, view, rowId) {
  if (kind === 'pursue') {
    const row = view?.rows.find((entry) => entry.id === rowId)
    if (row === undefined) return null
    return `[rich-tracking | pursue] The operator pressed PURSUE on tracking row "${row.label}" (${row.percent}%, ${row.status}). Make this row the focus of your next work: if it never started, start it now; if it stalled or the session was interrupted, resume it. Read the row's evidence artifacts for the remaining acceptance items, set your todo_write list to those concrete steps, and call tracking_write with refreshed percents after material progress or a verified blocker.`
  }
  if (kind === 'delegate') {
    const row = view?.rows.find((entry) => entry.id === rowId)
    if (row === undefined) return null
    const items = Array.isArray(row.items) && row.items.length > 0
      ? ` Its item checklist: ${row.items.map((item) => `${item.done === true ? '[x]' : '[ ]'} ${item.label}`).join('; ')}.`
      : ''
    const basis = row.evidence !== undefined ? ` Its evidence basis: ${row.evidence}.` : ''
    return `[rich-tracking | delegate] The operator pressed DELEGATE on tracking row "${row.label}" (${row.id}, ${row.percent}%, ${row.status}). Delegate this row to a background subagent now: use your subagent tool (run_in_background unless you need the result immediately) with read/write access to the workspace. Give the subagent a self-contained brief — the row's label, current percent and status,${items}${basis} plus the user context and file paths it needs — scoped strictly to this row's task and its subtasks. Require the subagent to track its own progress with tracking_write in its own session (a board scoped to this task and its subtasks only, percents updated after each step) and to return receipts (commits, test results, file paths) you can verify. When its report lands, fold the receipts into THIS row: update percent, item flags, and evidence to what actually holds, then call tracking_write with the corrected board.`
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
    return `[rich-tracking | dismiss] The operator dismissed row "${row.label}" (id "${row.id}") from the tracking board. Omit that row id from your next tracking_write unless its owning artifact re-opens it.`
  }
  if (kind === 'dismiss') {
    return '[rich-tracking | dismiss] The operator dismissed the tracking board. Stop updating it; do not call tracking_write unless the operator asks to re-open tracking.'
  }
  if (kind === 'play') {
    return '[rich-tracking | play] PLAY MODE is ON. After this turn ends, and after every subsequent turn, the board will automatically re-engage you with the highest-value next work. Pick the lowest-hanging fruit with the highest value ratio from the pending rows and work on it now.'
  }
  if (kind === 'pause') {
    return '[rich-tracking | pause] PLAY MODE is OFF. Work normally; the board will not auto-engage you after turns.'
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
  /** Per-session runtime: folded projection STATE (not the view — folds chain), staleness counters, turn caps. */
  const runtime = new WeakMap()

  const runtimeOf = (session) => {
    let entry = runtime.get(session)
    if (entry === undefined) {
      // First touch folds the FULL log: constructor seeds (resume/fork) never
      // fire session/event, so incremental-only would miss pre-existing boards.
      let state = null
      for (const event of ownEvents(session)) state = foldTracking(state, event)
      entry = { state, steps: 0, outputTokens: 0, remindedThisTurn: false, injectedThisTurn: false }
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
      entry.injectedThisTurn = false
      return
    }
    if (event.type === 'assistant/message') {
      entry.steps += 1
      entry.outputTokens += Number(event.data?.usage?.outputTokens ?? 0)
    }
  })

  // PLAY MODE: on turn/end, if playMode is active and there's pending work,
  // auto-engage the agent with the highest-value lowest-effort next step.
  // Engage fires ONLY on naturally completed turns — an operator Stop
  // (aborted) must not be undone 1.5s later, and refusal/max-tokens turns
  // must not re-engage into loops (review P1).
  const engageTimers = new Map()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (event?.data?.reason?.kind !== 'completed') return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    // Read the board from the session's OWN (post-seed) event log — children
    // never engage a parent's inherited board.
    let state = null
    for (const e of ownEvents(session)) state = foldTracking(state, e)
    const view = boardView(state)
    if (view === null || view.present !== true) return
    if (view.playMode !== true) return
    if (view.allDone === true) return
    // Find the lowest-hanging fruit: pending/active rows with the highest value ratio
    const pending = view.rows.filter((row) => row.percent < 100 && row.status !== 'blocked')
    if (pending.length === 0) return
    // Sort by: active first (already started = closer to done), then by percent descending (higher percent = less work remaining)
    const ranked = pending.sort((a, b) => (b.status === 'active' ? 1 : 0) - (a.status === 'active' ? 1 : 0) || b.percent - a.percent)
    const best = ranked[0]
    const rowsSummary = view.rows.map((row) => `${row.label} ${row.percent}% (${row.status})`).join('; ')
    const message = createPluginMessage(
      `[rich-tracking | auto-engage] Play mode is active. Current board: ${rowsSummary}. Pick up the lowest-hanging fruit with the highest value ratio: "${best.label}" (${best.percent}%, ${best.status}) — it is the closest to completion or the easiest to advance. Work on it now, then call tracking_write with refreshed percents.`,
      'followup',
      'play-mode engage',
    )
    // Dedupe queued engages per session; at fire, re-fold and re-check — a
    // pause/dismiss inside the window must win — and deliver only if the
    // agent is still idle (never steer the operator's fresh turn).
    const prior = engageTimers.get(session.id)
    if (prior !== undefined) clearTimeout(prior)
    const timer = setTimeout(() => {
      engageTimers.delete(session.id)
      try {
        let fireState = null
        for (const e of ownEvents(agent.session)) fireState = foldTracking(fireState, e)
        const fireView = boardView(fireState)
        if (fireView === null || fireView.present !== true || fireView.playMode !== true || fireView.allDone === true) return
        if (agent.status !== 'idle') return
        agent.followup(message)
      } catch { /* agent may have been disposed */ }
    }, 1500)
    engageTimers.set(session.id, timer)
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

      // Staleness backstop (design §10): one reminder per turn.
      if (entry.remindedThisTurn === false && (entry.steps >= REMINDER_STEPS || entry.outputTokens >= REMINDER_OUTPUT_TOKENS)) {
        entry.remindedThisTurn = true
        entry.injectedThisTurn = true
        const rows = view.rows.map((row) => `${row.label} ${row.percent}%`).join('; ')
        const message = createPluginMessage(
          `<tracking-refresh> The tracking board (revision r${view.revision}) is stale: ${entry.steps} assistant steps and ~${entry.outputTokens} output tokens since the last tracking_write. Current rows: ${rows}. Re-derive percents from artifact truth (the row evidence fields name the owners: plan snapshots, receipts, acceptance boxes) and call tracking_write with the corrected board. Keep a row's percent unchanged when its truth did not change. Do not mention this reminder to the user.`,
          'notice',
          'tracking refresh',
        )
        return { ...decision, messages: [...decision.messages, message] }
      }

      // Default submit-time injection (operator decision v0.3): while a live
      // board exists, the FIRST step of every turn carries a compact board
      // reminder — unless the assembly already carries richer tracking context
      // (a /track sync, a whip instruction, or the staleness reminder above).
      if (entry.injectedThisTurn === false && assemblyCarriesTracking(decision.messages) === false) {
        entry.injectedThisTurn = true
        const rows = view.rows.map((row) => `${row.label} ${row.percent}%`).join('; ')
        const message = createPluginMessage(
          `<tracking-board> Board r${view.revision} · ${view.overallPercent}% overall · ${rows}. Living-ledger duty: after each completed step, tracking_write the refreshed percents/items; refresh row prose when details change. Do not recite this to the user.`,
          'notice',
          'tracking board',
        )
        return { ...decision, messages: [...decision.messages, message] }
      }
      return decision
    })()
  })
}

/** Whether the trailing assembly messages already carry tracking context (dedupe). */
function assemblyCarriesTracking(messages) {
  if (Array.isArray(messages) === false) return false
  return messages.slice(-3).some((message) => {
    const block = Array.isArray(message?.content) ? message.content.find((part) => part.type === 'text') : null
    const text = block?.text ?? ''
    return text.startsWith('<tracking') || text.startsWith('[rich-tracking')
  })
}

export function apply(ctx) {
  // Register before any history consumer can ask persistence to interpret a
  // stored tracking event. The injection fiber owns the disposer, so plugin
  // unload and HMR close the compatibility window with the projection code.
  ctx.inject(['sessionEventTypes'], (eventTypesCtx) => {
    eventTypesCtx.effect(
      () => eventTypesCtx.sessionEventTypes.register(TRACKING_EVENT_TYPES, name),
      'rich-tracking: session event types',
    )
  })

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

  // /track (operator decision v0.3): the chat command that forces a ledger
  // sync. Same grammar family as /plan — bare invocation or trailing message;
  // the trailing message rides along as the user's own words, with the full
  // ledger plus doctrine injected into the next step (the /plan leadingInput
  // pattern: steer when running, followup when idle).
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'track',
      description: 'Tracking ledger sync: injects the current board plus the tracking doctrine into the agent\'s next step',
      input: { hint: '[message]' },
      handler: ({ agent, rawInput }) => {
        let state = null
        for (const event of ownEvents(agent.session)) state = foldTracking(state, event)
        const view = boardView(state)
        const message = rawInput.trim()
        const text = `${message !== '' ? `${message}\n\n` : ''}<tracking-sync>\n${ledgerContext(view)}`
        const userMessage = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
        if (agent.status === 'running') agent.steer(userMessage)
        else agent.followup(userMessage)
        return {
          kind: 'success',
          text: view === null || view.present !== true
            ? 'No board yet — tracking doctrine injected; the agent will create a board if the work spans steps.'
            : `Ledger r${view.revision} injected (${view.overallPercent}% overall) — the agent will re-derive and update it.`,
        }
      },
    })
  })

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/tracks`,
      handler: (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        scanTracks(ctx).then((result) => writeJson(res, 200, { ok: true, ...result }))
          .catch((error) => {
            console.warn(`[dsh-rich-tracking] tracks scan failed: ${error instanceof Error ? error.message : String(error)}`)
            writeJson(res, 500, { ok: false, error: 'scan-failed' })
          })
      },
    })
    const disposeAction = ctx.webServer.register({
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
        const kinds = new Set(['pursue', 'delegate', 'align', 'dismiss', 'dismiss-row', 'checkpoint-request', 'play', 'pause'])
        if (kinds.has(body.kind) === false) { writeJson(res, 400, { ok: false, error: 'unknown-action' }); return }

        const agent = ctx.agents.get(body.sessionId)
        if (agent === undefined) { writeJson(res, 409, { ok: false, error: 'session-offline' }); return }

        // Fold the current board for instruction templating.
        let state = null
        for (const event of ownEvents(agent.session)) state = foldTracking(state, event)
        const view = boardView(state)

        // Operator rule 2026-08-28: a board with open rows cannot be dismissed —
        // tracks that are not 100% must never disappear. Whole-board dismiss is
        // only valid once every row is done (row-level dismiss stays available).
        if (body.kind === 'dismiss' && Array.isArray(view?.rows) && view.rows.some((row) => row.percent < 100)) {
          writeJson(res, 400, { ok: false, error: 'board-dismiss-blocked: open rows remain — finish them or dismiss rows individually' })
          return
        }
        const instruction = instructionFor(body.kind, view, body.rowId)
        if (instruction === null) { writeJson(res, 400, { ok: false, error: 'row-not-found' }); return }

        agent.session.append('tracking/decision', { kind: body.kind, rowId: body.rowId ?? null, instruction, at: Date.now() })

        const whip = body.kind === 'pursue' || body.kind === 'delegate' || body.kind === 'align' || body.kind === 'checkpoint-request' || body.kind === 'play' || body.kind === 'pause'
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
    return () => {
      disposeAction()
      dispose()
    }
  }, 'rich-tracking: action + tracks routes')
}
