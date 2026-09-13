/** Pure replay fold and strict decoder for durable goal changes. */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { GOAL_CHANGE_VERSION, GoalId } from './runtime.ts'
import type { GoalBlockReason, GoalPhase, GoalRef, GoalSnapshot } from './types.ts'
import type {
  FoldedGoal,
  GoalChangeMeta,
  GoalClearChangeMeta,
  GoalMessageSource,
  GoalOperation,
  GoalSnapshotChangeMeta,
} from './domain.ts'

const SNAPSHOT_OPERATIONS: ReadonlySet<Exclude<GoalOperation, 'clear'>> = new Set([
  'create',
  'edit',
  'pause',
  'resume',
  'complete',
  'block',
])
const PHASES: ReadonlySet<GoalPhase> = new Set(['active', 'paused', 'blocked', 'complete'])

/** Mutable accumulator kept private to the pure fold. */
export interface GoalFoldState {
  goal: GoalSnapshot | undefined
  roundsStarted: number
  tokensAtCreate: number | undefined
  workMsAtCreate: number | undefined
  createdAt: number | undefined
  updatedAt: number | undefined
  lastRef: GoalRef | undefined
  seenGoalIds: Set<GoalSnapshot['id']>
}

/**
 * Build an empty replay accumulator.
 * @returns mutable state with no current goal or prior ref.
 */
export function emptyGoalFoldState(): GoalFoldState {
  return {
    goal: undefined,
    roundsStarted: 0,
    tokensAtCreate: undefined,
    workMsAtCreate: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenGoalIds: new Set(),
  }
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Require every named field and reject any unnamed one. Required and optional
 * sets stay separate so an additive payload field remains readable on records
 * written before it existed, while an unrecognized field still fails replay.
 */
function requireFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing the ${key} field`)
  }
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has an unknown ${key} field`)
  }
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`goal change ${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`goal change ${field} must be a non-negative safe integer`)
  }
  return value
}

/**
 * Decode one optional recorded counter.
 * @param value - candidate field, absent when the record predates it.
 * @param field - field name used in the rejection message.
 * @returns the validated count, or `undefined` when the record omits it.
 */
function optionalCounter(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, field)
}

/**
 * Decode one budget ceiling. An absent field and an explicit `null` both mean
 * unbounded, so a record written before budgets existed reads as unbounded
 * rather than as a zero budget.
 */
function decodeBudget(value: unknown, field: string): number | null {
  return value === undefined || value === null ? null : positiveInteger(value, field)
}

/** Decode one canonical blocker explanation. */
function decodeBlockReason(value: unknown): GoalBlockReason {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'code,message') {
    throw new Error('goal change goal.blockedReason must have exactly code and message fields')
  }
  if (typeof value['code'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value['code'])) {
    throw new Error('goal change goal.blockedReason.code must be lower-kebab-case')
  }
  if (typeof value['message'] !== 'string' || value['message'].trim().length === 0
    || value['message'] !== value['message'].trim()) {
    throw new Error('goal change goal.blockedReason.message must be non-empty and normalized')
  }
  return { code: value['code'], message: value['message'] }
}

/** Decode and validate one snapshot. */
function decodeSnapshot(value: unknown): GoalSnapshot {
  if (!isRecord(value)) throw new Error('goal change goal must be a record')
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('goal change goal.id must be a non-empty string')
  }
  if (typeof value['objective'] !== 'string' || value['objective'].trim().length === 0
    || value['objective'] !== value['objective'].trim()) {
    throw new Error('goal change goal.objective must be non-empty and normalized')
  }
  if (typeof value['phase'] !== 'string' || !PHASES.has(value['phase'] as GoalPhase)) {
    throw new Error('goal change goal.phase is invalid')
  }
  const phase = value['phase'] as GoalPhase
  const required = phase === 'blocked'
    ? ['blockedReason', 'id', 'maxGoalRounds', 'objective', 'phase', 'revision']
    : ['id', 'maxGoalRounds', 'objective', 'phase', 'revision']
  requireFields(value, required, ['maxGoalTokens', 'maxGoalWorkMs'], `goal change goal for phase ${phase}`)
  return {
    id: GoalId(value['id']),
    revision: positiveInteger(value['revision'], 'goal.revision'),
    objective: value['objective'],
    phase,
    maxGoalRounds: positiveInteger(value['maxGoalRounds'], 'goal.maxGoalRounds'),
    maxGoalTokens: decodeBudget(value['maxGoalTokens'], 'goal.maxGoalTokens'),
    maxGoalWorkMs: decodeBudget(value['maxGoalWorkMs'], 'goal.maxGoalWorkMs'),
    ...phase === 'blocked' ? { blockedReason: decodeBlockReason(value['blockedReason']) } : {},
  }
}

/** Decode and validate one ref. */
function decodeRef(value: unknown): GoalRef {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,revision') {
    throw new Error('goal clear tombstone must have exactly id and revision fields')
  }
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('goal clear tombstone id must be a non-empty string')
  }
  return { id: GoalId(value['id']), revision: positiveInteger(value['revision'], 'cleared.revision') }
}

/**
 * Decode a value that declares itself as a goal change. Unrelated values
 * return `undefined`; malformed goal changes fail replay loudly.
 * @param value - candidate source change.
 * @returns validated goal change or `undefined` for another value kind.
 */
export function decodeGoalChange(value: unknown): GoalChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'goal/change') return undefined
  if (value['version'] !== GOAL_CHANGE_VERSION) {
    throw new Error(`unsupported goal change version ${String(value['version'])}`)
  }
  if (value['operation'] === 'clear') {
    requireFields(
      value,
      ['cleared', 'clearedAt', 'kind', 'operation', 'version'],
      [],
      'goal clear change',
    )
    return {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeRef(value['cleared']),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    } satisfies GoalClearChangeMeta
  }
  if (typeof value['operation'] !== 'string'
    || !SNAPSHOT_OPERATIONS.has(value['operation'] as Exclude<GoalOperation, 'clear'>)) {
    throw new Error('goal change operation is invalid')
  }
  requireFields(
    value,
    ['createdAt', 'goal', 'kind', 'operation', 'roundsStarted', 'updatedAt', 'version'],
    ['tokensAtCreate', 'workMsAtCreate'],
    'goal snapshot change',
  )
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt')
  if (updatedAt < createdAt) throw new Error('goal change updatedAt cannot precede createdAt')
  const goal = decodeSnapshot(value['goal'])
  const tokensAtCreate = optionalCounter(value['tokensAtCreate'], 'tokensAtCreate')
  const workMsAtCreate = optionalCounter(value['workMsAtCreate'], 'workMsAtCreate')
  if ((goal.maxGoalTokens !== null && tokensAtCreate === undefined)
    || (goal.maxGoalWorkMs !== null && workMsAtCreate === undefined)) {
    throw new Error('goal change that names a budget must also carry its create-time baseline')
  }
  return {
    kind: 'goal/change',
    version: GOAL_CHANGE_VERSION,
    operation: value['operation'] as Exclude<GoalOperation, 'clear'>,
    goal,
    roundsStarted: nonNegativeInteger(value['roundsStarted'], 'roundsStarted'),
    ...tokensAtCreate === undefined ? {} : { tokensAtCreate },
    ...workMsAtCreate === undefined ? {} : { workMsAtCreate },
    createdAt,
    updatedAt,
  } satisfies GoalSnapshotChangeMeta
}

/** Narrow model attribution to a valid goal source. */
function goalSource(source: MessageSource): GoalMessageSource | undefined {
  if (source.kind !== 'goal') return undefined
  if (typeof source.goalId !== 'string' || source.goalId.length === 0
    || !Number.isSafeInteger(source.revision) || source.revision < 1
    || !Number.isSafeInteger(source.round) || source.round < 1) {
    throw new Error('goal message source is invalid')
  }
  return {
    kind: 'goal',
    goalId: GoalId(source.goalId),
    revision: source.revision,
    round: source.round,
    ...source.tokensUsed === undefined
      ? {}
      : { tokensUsed: nonNegativeInteger(source.tokensUsed, 'user/message goal source tokensUsed') },
    ...source.workMsUsed === undefined
      ? {}
      : { workMsUsed: nonNegativeInteger(source.workMsUsed, 'user/message goal source workMsUsed') },
  }
}

/** Require two snapshots to retain fields that only `edit` may replace. */
function requireSameDefinition(current: GoalSnapshot, next: GoalSnapshot, operation: GoalOperation): void {
  if (next.objective !== current.objective
    || next.maxGoalRounds !== current.maxGoalRounds
    || next.maxGoalTokens !== current.maxGoalTokens
    || next.maxGoalWorkMs !== current.maxGoalWorkMs) {
    throw new Error(`goal ${operation} cannot change the objective, round cap, or budgets`)
  }
}

/** Require one exact next revision of the current goal. */
function requireNextRevision(current: GoalSnapshot, next: GoalRef, operation: GoalOperation): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`goal ${operation} must advance the current goal by one revision`)
  }
}

/** Validate one non-create snapshot operation against the preceding projection. */
function validateSnapshotTransition(
  state: GoalFoldState,
  change: GoalSnapshotChangeMeta,
  current: GoalSnapshot,
): void {
  const next = change.goal
  requireNextRevision(current, next, change.operation)
  /* v8 ignore next -- a current goal established by this fold always has an updatedAt */
  if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt')
  if (change.createdAt !== state.createdAt
    || change.updatedAt < state.updatedAt
    || change.roundsStarted !== state.roundsStarted
    || change.tokensAtCreate !== state.tokensAtCreate
    || change.workMsAtCreate !== state.workMsAtCreate) {
    throw new Error(`goal ${change.operation} does not preserve the current counters, baselines, and timestamps`)
  }
  switch (change.operation) {
    case 'edit':
      if (next.phase !== current.phase
        || JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)) {
        throw new Error('goal edit cannot change phase or blocked reason')
      }
      break
    case 'pause':
      requireSameDefinition(current, next, change.operation)
      if (current.phase !== 'active' || next.phase !== 'paused') throw new Error('goal pause has an invalid phase transition')
      break
    case 'resume': {
      requireSameDefinition(current, next, change.operation)
      const resumable: ReadonlySet<GoalPhase> = new Set([
        'active',
        'paused',
        'blocked',
      ])
      if (!resumable.has(current.phase) || next.phase !== 'active' || state.roundsStarted >= next.maxGoalRounds) {
        throw new Error('goal resume has an invalid phase transition or exhausted round budget')
      }
      break
    }
    case 'complete':
      requireSameDefinition(current, next, change.operation)
      if (current.phase === 'complete' || next.phase !== 'complete') throw new Error('goal complete has an invalid phase transition')
      break
    case 'block':
      requireSameDefinition(current, next, change.operation)
      if (current.phase !== 'active' || next.phase !== 'blocked') throw new Error('goal block has an invalid phase transition')
      break
    /* v8 ignore start -- the caller excludes create and GoalOperation is closed; these arms retain fail-loud exhaustiveness */
    case 'create':
      throw new Error('goal create cannot be validated as a current-goal transition')
    default:
      change.operation satisfies never
      throw new Error('unknown goal snapshot operation')
    /* v8 ignore stop */
  }
}

/**
 * Return the revision identity carried by a snapshot or tombstone.
 * @param change - decoded goal mutation.
 * @returns stable identity used to reconcile a deferred change with its log event.
 */
export function goalChangeRef(change: GoalChangeMeta): GoalRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.goal.id, revision: change.goal.revision }
}

/**
 * Validate and apply one decoded change to a mutable accumulator.
 * @param state - preceding durable goal projection.
 * @param change - decoded full snapshot or clear tombstone.
 */
export function applyGoalChange(state: GoalFoldState, change: GoalChangeMeta): void {
  const ref = goalChangeRef(change)
  if (change.operation === 'clear') {
    const current = state.goal
    if (current === undefined) throw new Error('goal clear requires a current goal')
    requireNextRevision(current, change.cleared, change.operation)
    /* v8 ignore next -- a current goal established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt')
    if (change.clearedAt < state.updatedAt) {
      throw new Error('goal clear timestamp cannot precede the current goal update')
    }
    state.goal = undefined
    state.roundsStarted = 0
    state.tokensAtCreate = undefined
    state.workMsAtCreate = undefined
    state.createdAt = undefined
    state.updatedAt = undefined
    state.lastRef = ref
    return
  }
  if (change.operation === 'create') {
    if (change.goal.revision !== 1 || change.goal.phase !== 'active' || change.roundsStarted !== 0
      || (state.goal !== undefined && state.goal.phase !== 'complete')
      || state.seenGoalIds.has(change.goal.id)) {
      throw new Error('goal create requires a fresh active revision-one goal with zero rounds')
    }
    state.seenGoalIds.add(change.goal.id)
  } else {
    const current = state.goal
    if (current === undefined) throw new Error(`goal ${change.operation} requires a current goal`)
    validateSnapshotTransition(state, change, current)
  }
  state.goal = change.goal
  state.roundsStarted = change.roundsStarted
  state.tokensAtCreate = change.tokensAtCreate
  state.workMsAtCreate = change.workMsAtCreate
  state.createdAt = change.createdAt
  state.updatedAt = change.updatedAt
  state.lastRef = ref
}

/**
 * Apply one session event to the strict durable goal fold.
 * @param state - mutable fold accumulator.
 * @param event - next event in sequence order.
 */
export function applyGoalEvent(state: GoalFoldState, event: SessionEvent): void {
  if (event.type === 'goal/change') {
    const change = decodeGoalChange(event.data)
    /* v8 ignore next -- the event's declared payload always identifies itself as a goal change. */
    if (change === undefined) throw new Error(`goal change at session event ${event.seq} has an invalid kind`)
    applyGoalChange(state, change)
    return
  }
  if (event.type === 'user/message') {
    const source = goalSource(event.data.source)
    if (source === undefined) return
    const current = state.goal
    if (current === undefined || current.phase !== 'active' || source.goalId !== current.id
      || source.revision !== current.revision || source.round !== state.roundsStarted + 1
      || source.round > current.maxGoalRounds) {
      throw new Error(`goal round at session event ${event.seq} is not the next admitted round of the active goal`)
    }
    state.roundsStarted = source.round
  }
}

/**
 * Fold current goal state from a contiguous session event log.
 * @param events - session events in sequence order.
 * @returns a fresh durable projection; activation is deliberately absent.
 */
export function foldGoal(events: readonly SessionEvent[]): FoldedGoal {
  const state = emptyGoalFoldState()
  for (const event of events) applyGoalEvent(state, event)
  return {
    ...state.goal === undefined ? {} : { goal: { ...state.goal } },
    roundsStarted: state.roundsStarted,
    ...state.tokensAtCreate === undefined ? {} : { tokensAtCreate: state.tokensAtCreate },
    ...state.workMsAtCreate === undefined ? {} : { workMsAtCreate: state.workMsAtCreate },
    ...state.createdAt === undefined ? {} : { createdAt: state.createdAt },
    ...state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt },
    ...state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } },
  }
}
