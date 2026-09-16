/**
 * Same-session goal domain: event-sourced state, compare-and-set mutations,
 * and process-local continuation activation.
 * @module @deepseek-ai/dsh-goal
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: activates the `tokenUsage` and `sessionStats` projection-key
// merges this service reads to meter a goal's budgets. Neither package is a
// runtime dependency, and an unmetered deployment still stores unbudgeted goals.
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-stats'
// Type-only: the optional settings service, which turns these defaults into a
// runtime-editable section. Without a provider the composed entry stays in force.
import type {} from '@deepseek-ai/dsh-settings'
import {
  applyGoalEvent,
  goalChangeRef,
} from './fold.ts'
import type { GoalFoldState } from './fold.ts'
import {
  GOAL_CHANGE_VERSION,
  GoalError,
  GoalId,
} from './runtime.ts'
import type {
  CreateGoalRequest,
  CreateGoalResult,
  EditGoalRequest,
  GoalActivation,
  GoalBlockReason,
  GoalBudgetKind,
  GoalPhase,
  GoalProjection,
  GoalProjectionState,
  GoalRef,
  GoalSnapshot,
  GoalView,
} from './types.ts'
import { roundWithinCap, roundsExhausted } from './domain.ts'
import type {
  GoalChangeMeta,
  GoalChanged,
  GoalClearChangeMeta,
  GoalOperation,
  GoalSnapshotChangeMeta,
} from './domain.ts'

// The pure payload outlet (./types.ts, ONE home of the `goal` projection-key
// declaration) re-exported onto the package root keeps the module edge in
// the emitted index.d.ts, so aggregate programs consuming the declarations
// still receive the SessionProjectionStateMap merge.
export type * from './types.ts'
export type * from './domain.ts'
export { roundWithinCap, roundsExhausted } from './domain.ts'
export { GOAL_CHANGE_VERSION, GoalError, GoalId } from './runtime.ts'
export { decodeGoalChange, foldGoal, goalChangeRef } from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    goals: GoalService
  }
}

/** Wire payload schema of the `goal` projection (current goal or pre-create/cleared null). */
const goalProjectionSchema: ZodType<GoalProjection | null> = zod.union([
  zod.object({
    goal: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      phase: zod.union([zod.literal('active'), zod.literal('paused'), zod.literal('blocked'), zod.literal('complete')]),
      blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
      maxGoalRounds: zod.number().int().positive().nullable(),
      maxGoalTokens: zod.number().int().positive().nullable(),
      maxGoalWorkMs: zod.number().int().positive().nullable(),
    }),
    roundsStarted: zod.number().int().nonnegative(),
    tokensAtCreate: zod.number().int().nonnegative().optional(),
    workMsAtCreate: zod.number().int().nonnegative().optional(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  }),
  zod.null(),
]) as ZodType<GoalProjection | null>

const goalProjectionStateSchema: ZodType<GoalProjectionState> = zod.object({
  current: goalProjectionSchema,
  seenGoalIds: zod.array(zod.string().min(1)).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'seen goal ids must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
}).strict().superRefine((state, context) => {
  if (state.current === null) return
  if (!state.seenGoalIds.includes(state.current.goal.id)) {
    context.addIssue({ code: 'custom', message: 'current goal id must be retained among seen goal ids' })
  }
  if (state.current.updatedAt < state.current.createdAt) {
    context.addIssue({ code: 'custom', message: 'current goal update cannot precede its creation' })
  }
  if (!roundWithinCap(state.current.goal, state.current.roundsStarted)) {
    context.addIssue({ code: 'custom', message: 'current goal rounds cannot exceed its configured limit' })
  }
  const { maxGoalTokens, maxGoalWorkMs } = state.current.goal
  if ((maxGoalTokens !== null && state.current.tokensAtCreate === undefined)
    || (maxGoalWorkMs !== null && state.current.workMsAtCreate === undefined)) {
    context.addIssue({ code: 'custom', message: 'a budgeted current goal must retain its create-time baseline' })
  }
}) as unknown as ZodType<GoalProjectionState>

/** Build strict fold state from one checkpoint-safe projection state. */
function goalFoldState(state: GoalProjectionState): GoalFoldState {
  return {
    goal: state.current?.goal,
    roundsStarted: state.current?.roundsStarted ?? 0,
    tokensAtCreate: state.current?.tokensAtCreate,
    workMsAtCreate: state.current?.workMsAtCreate,
    createdAt: state.current?.createdAt,
    updatedAt: state.current?.updatedAt,
    lastRef: undefined,
    seenGoalIds: new Set(state.seenGoalIds),
  }
}

/** Convert strict fold state into checkpoint-safe projection state. */
function goalProjectionState(state: GoalFoldState): GoalProjectionState {
  let current: GoalProjection | null = null
  if (state.goal !== undefined) {
    const { createdAt, updatedAt } = state
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error('current goal fold lacks timestamps')
    }
    current = {
      goal: state.goal,
      roundsStarted: state.roundsStarted,
      ...state.tokensAtCreate === undefined ? {} : { tokensAtCreate: state.tokensAtCreate },
      ...state.workMsAtCreate === undefined ? {} : { workMsAtCreate: state.workMsAtCreate },
      createdAt,
      updatedAt,
    }
  }
  return {
    current,
    seenGoalIds: [...state.seenGoalIds],
    failure: null,
  }
}

/**
 * Fold durable goal events through the strict replay rules without throwing
 * from the projection registry's event drive. The first invalid owned event
 * is retained in `failure`; host goal access rejects that state while the
 * client view remains at the last valid goal.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is unrelated).
 */
export function applyGoalProjection(state: GoalProjectionState, event: SessionEvent): GoalProjectionState {
  if (state.failure !== null) return state
  if (event.type !== 'goal/change'
    && (event.type !== 'user/message' || event.data.source.kind !== 'goal')) return state
  const folded = goalFoldState(state)
  try {
    applyGoalEvent(folded, event)
    return goalProjectionState(folded)
  } catch (error: unknown) {
    /* v8 ignore next -- the strict goal fold throws Error instances. */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `goal replay failed at session event ${event.seq}: ${message}` }
  }
}

/** Strict host goal state with the existing cropped client value. */
export const goalProjectionDefinition = {
  key: 'goal',
  stateSchema: goalProjectionStateSchema,
  init: (): GoalProjectionState => ({ current: null, seenGoalIds: [], failure: null }),
  apply: applyGoalProjection,
  wire: { viewSchema: goalProjectionSchema, view: state => state.current },
  stateVersion: 7,
} satisfies ProjectionDefinition<'goal', GoalProjectionState>

/** Deployment defaults for goal creation. */
export interface Config {
  /** Round cap used when a create request omits its own; absent or null leaves it unbounded. */
  defaultMaxGoalRounds?: number
  /**
   * Token ceiling for every goal this deployment admits. It is the default a
   * create request inherits and the maximum any request may name; unset leaves
   * goals unbounded in tokens.
   */
  maxGoalTokens?: number
  /**
   * Active model-and-tool millisecond ceiling for every goal this deployment
   * admits. It is the default a create request inherits and the maximum any
   * request may name; unset leaves goals unbounded in active work.
   */
  maxGoalWorkMs?: number
}

/** Settings namespace carrying the deployment defaults for goal creation. */
export const GOAL_SETTINGS_NAMESPACE = 'goal'

/** Resolved defaults. */
export interface ResolvedConfig {
  /** Validated default round cap, or null while continuation is unbounded by rounds. */
  defaultMaxGoalRounds: number | null
  /** Validated token ceiling that doubles as the default, or null while unbounded. */
  maxGoalTokens: number | null
  /** Validated active-work ceiling in milliseconds that doubles as the default, or null while unbounded. */
  maxGoalWorkMs: number | null
}

/** Process-local activation state crossing the synchronous append boundary. */
interface GoalRuntimeState {
  activation: GoalActivation
  pendingActivation: {
    readonly offset: SessionLogOffset
    readonly activation: GoalActivation
  } | undefined
}

/**
 * Derived per-goal counters carried by every non-clear mutation.
 * `roundsStarted` advances on admitted rounds; the two baselines are recorded
 * at create and retained unchanged by every later mutation, which is what lets
 * a budget compare against the same accounting source after replay or restart.
 */
interface GoalCounters {
  readonly roundsStarted: number
  readonly tokensAtCreate?: number
  readonly workMsAtCreate?: number
}

/**
 * Attach recorded baselines to one mutation's counters.
 * @param tokensAtCreate - token baseline, absent when this deployment meters no tokens.
 * @param workMsAtCreate - active-work baseline, absent when this deployment meters no statistics.
 * @returns the recorded baselines, omitting an unmeasured one so no caller sees an explicit `undefined`.
 */
function withBaselines(
  tokensAtCreate: number | undefined,
  workMsAtCreate: number | undefined,
): Pick<GoalCounters, 'tokensAtCreate' | 'workMsAtCreate'> {
  return {
    ...tokensAtCreate === undefined ? {} : { tokensAtCreate },
    ...workMsAtCreate === undefined ? {} : { workMsAtCreate },
  }
}

/** Validated create input with every deployment default materialized. */
interface ResolvedCreateGoal {
  readonly objective: string
  readonly maxGoalRounds: number | null
  readonly maxGoalTokens: number | null
  readonly maxGoalWorkMs: number | null
}

/**
 * Resolve one caller-visible round cap. An omitted field keeps the deployment
 * default, an explicit `null` leaves continuation unbounded by rounds, and a
 * named value must be a positive safe integer.
 * @param value - caller value, the deployment default, or an explicit removal.
 * @param fallback - resolved deployment default for an omitted field.
 * @returns the resolved cap, or null while unbounded.
 */
function resolveMaxGoalRounds(value: number | null | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer or null', 'GOAL_INVALID_MAX_ROUNDS')
  }
  return value
}

/**
 * Resolve one caller-visible budget ceiling against the deployment's own
 * limit. An omitted field inherits that limit, a named value must be a
 * positive safe integer no larger than it, and an explicit `null` is accepted
 * only while the deployment sets no limit. The deployment's value is therefore
 * both the default a request inherits and the most any request may be granted.
 * @param value - caller value, or an explicit removal.
 * @param limit - resolved deployment ceiling, or null while this deployment bounds nothing.
 * @param field - caller-visible field name used in the rejection message.
 * @returns the resolved ceiling, or null while unbounded.
 */
function resolveBudget(value: number | null | undefined, limit: number | null, field: string): number | null {
  if (value === undefined) return limit
  if (value === null) {
    if (limit === null) return null
    throw new GoalError(
      `${field} cannot be unbounded while the deployment bounds it at ${limit}`,
      'GOAL_BUDGET_EXCEEDS_LIMIT',
    )
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError(`${field} must be a positive safe integer or null`, 'GOAL_INVALID_BUDGET')
  }
  if (limit !== null && value > limit) {
    throw new GoalError(
      `${field} ${value} exceeds the deployment limit of ${limit}`,
      'GOAL_BUDGET_EXCEEDS_LIMIT',
    )
  }
  return value
}

/**
 * First budget without remaining capacity, in {@link GoalBudgetKind} order.
 * A budget whose accounting is unavailable reports no exhaustion: `create` and
 * `edit` already refuse a budget this deployment cannot meter, and a meter
 * that disappears afterwards must not strand an active goal.
 * @param goal - current durable snapshot carrying the ceilings.
 * @param tokensUsed - tokens spent since creation, or null when unmeasured.
 * @param workMsUsed - active work spent since creation, or null when unmeasured.
 * @returns the exhausted budget kind, or null while every ceiling retains capacity.
 */
function exhaustedBudget(
  goal: GoalSnapshot,
  tokensUsed: number | null,
  workMsUsed: number | null,
): GoalBudgetKind | null {
  if (goal.maxGoalTokens !== null && tokensUsed !== null && tokensUsed >= goal.maxGoalTokens) return 'tokens'
  if (goal.maxGoalWorkMs !== null && workMsUsed !== null && workMsUsed >= goal.maxGoalWorkMs) return 'work'
  return null
}

/** Validate and normalize an objective at the domain boundary. */
function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE')
  }
  return value.trim()
}

/**
 * Validate one configured deployment ceiling.
 * @param value - configured ceiling, absent while this deployment bounds nothing.
 * @param field - configuration field name used in the rejection message.
 * @returns the validated ceiling, or null while unbounded.
 */
function validateDeploymentCeiling(value: number | undefined, field: string): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError(`${field} must be a positive safe integer`, 'GOAL_INVALID_BUDGET')
  }
  return value
}

/** Materialize one configuration section into validated deployment defaults. */
function resolveDefaults(config: Config): ResolvedConfig {
  return {
    defaultMaxGoalRounds: resolveMaxGoalRounds(config.defaultMaxGoalRounds, null),
    maxGoalTokens: validateDeploymentCeiling(config.maxGoalTokens, 'maxGoalTokens'),
    maxGoalWorkMs: validateDeploymentCeiling(config.maxGoalWorkMs, 'maxGoalWorkMs'),
  }
}

/** Materialize deployment defaults and validate one create request. */
function resolveCreateGoal(request: CreateGoalRequest, defaults: ResolvedConfig): ResolvedCreateGoal {
  return {
    objective: resolveObjective(request.objective),
    maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds, defaults.defaultMaxGoalRounds),
    maxGoalTokens: resolveBudget(request.maxGoalTokens, defaults.maxGoalTokens, 'maxGoalTokens'),
    maxGoalWorkMs: resolveBudget(request.maxGoalWorkMs, defaults.maxGoalWorkMs, 'maxGoalWorkMs'),
  }
}

/** Validate and detach one policy-owned blocker explanation. */
function resolveBlockReason(reason: unknown): GoalBlockReason {
  const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? reason as Record<string, unknown>
    : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}

/** Goal service (`ctx.goals`) backed exclusively by the owning session log. */
export class GoalService extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections']

  static Config: z<Config> = z.object({
    defaultMaxGoalRounds: z.number().step(1).min(1),
    maxGoalTokens: z.number().step(1).min(1),
    maxGoalWorkMs: z.number().step(1).min(1),
  })

  private source: () => Config
  private readonly runtimeStates = new WeakMap<Session, GoalRuntimeState>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'goals')
    const entry = config
    this.source = () => entry
    // Fail loud at load on an unusable composition entry, before any create.
    this.defaults()
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, GOAL_SETTINGS_NAMESPACE, GoalService.Config, entry, {
        setSource: (current) => { this.source = current },
        // Nothing is memoized: every create reads the source, so a committed
        // change needs no re-derivation here.
        onChange: () => {},
        // A section every create would refuse must not commit in the first place.
        validate: (value) => { resolveDefaults(value) },
      })
    })
    ctx.on('agent/created', ({ agent }) => {
      this.setActivation(agent.session, 'disarmed')
    })
    ctx.sessionProjections.register(goalProjectionDefinition)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'goal/change') return
      const runtime = this.runtimeState(session)
      const activation = runtime.pendingActivation !== undefined
        && SessionSeq(runtime.pendingActivation.offset) === event.seq
        ? runtime.pendingActivation.activation
        : 'disarmed'
      this.setActivation(session, activation)
    })
  }

  /**
   * Resolve the deployment defaults from the active configuration source.
   * @returns validated defaults for one create request.
   */
  private defaults(): ResolvedConfig {
    return resolveDefaults(this.source())
  }

  /**
   * Read the current goal for one exact live agent.
   * @param agent - owning live agent.
   * @returns a fresh view or `undefined` when no goal is current.
   * @throws {@link GoalError} when the agent is not the registry's live instance.
   */
  @Remote('get')
  get(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    return this.view(agent.session, this.state(agent.session), this.runtimeState(agent.session))
  }

  /**
   * Remove process-local continuation authority without changing durable goal
   * phase or revision. Lifecycle owners use this before unloading a driver;
   * a later human-authorized {@link resume} records the new activation edge.
   * @param agent - owning live agent.
   * @returns a fresh disarmed view, or `undefined` when no goal is current.
   */
  disarm(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    this.setActivation(agent.session, 'disarmed')
    const runtime = this.runtimeState(agent.session)
    return this.view(agent.session, this.state(agent.session), runtime)
  }

  /**
   * Create and arm a goal. A completed goal may be replaced; every other
   * current phase must be cleared or resumed instead.
   * @param agent - owning live agent.
   * @param request - objective and optional round cap.
   * @returns the created live view.
   */
  create(agent: Agent, request: CreateGoalRequest): GoalView {
    const spec = resolveCreateGoal(request, this.defaults())
    const [state, runtime] = this.prepareMutation(agent)
    const current = state?.goal
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS')
    }
    const tokensAtCreate = this.tokensAt(agent.session, spec.maxGoalTokens !== null)
    const workMsAtCreate = this.workMsAt(agent.session, spec.maxGoalWorkMs !== null)
    const now = Date.now()
    const goal: GoalSnapshot = {
      id: GoalId(`goal-${randomUUID()}`),
      revision: 1,
      objective: spec.objective,
      phase: 'active',
      maxGoalRounds: spec.maxGoalRounds,
      maxGoalTokens: spec.maxGoalTokens,
      maxGoalWorkMs: spec.maxGoalWorkMs,
    }
    return this.commitSnapshot(
      agent,
      runtime,
      'create',
      goal,
      { roundsStarted: 0, ...withBaselines(tokensAtCreate, workMsAtCreate) },
      now,
      now,
      'armed',
    )
  }

  /**
   * Edit objective and/or round cap without changing phase.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param request - at least one replacement field.
   * @returns the edited view.
   */
  @Remote('edit')
  edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const defaults = this.defaults()
    if (request.objective === undefined && request.maxGoalRounds === undefined
      && request.maxGoalTokens === undefined && request.maxGoalWorkMs === undefined) {
      throw new GoalError(
        'goal edit requires objective, maxGoalRounds, maxGoalTokens, and/or maxGoalWorkMs',
        'GOAL_INVALID_EDIT',
      )
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...request.objective === undefined ? {} : { objective: resolveObjective(request.objective) },
      ...request.maxGoalRounds === undefined
        ? {}
        : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds, null) },
      ...request.maxGoalTokens === undefined
        ? {}
        : { maxGoalTokens: resolveBudget(request.maxGoalTokens, defaults.maxGoalTokens, 'maxGoalTokens') },
      ...request.maxGoalWorkMs === undefined
        ? {}
        : { maxGoalWorkMs: resolveBudget(request.maxGoalWorkMs, defaults.maxGoalWorkMs, 'maxGoalWorkMs') },
    }
    return this.commitCurrent(agent, currentState, runtime, 'edit', goal, runtime.activation, {
      roundsStarted: currentState.roundsStarted,
      ...withBaselines(
        this.editTokensBaseline(agent.session, currentState, goal.maxGoalTokens),
        this.editWorkMsBaseline(agent.session, currentState, goal.maxGoalWorkMs),
      ),
    })
  }

  /**
   * Resolve the token baseline an edit retains. A goal that already recorded
   * one keeps it; a goal gaining its first token budget records the current
   * total, so that budget meters work admitted from this mutation onward.
   */
  private editTokensBaseline(session: Session, state: GoalProjection, budget: number | null): number | undefined {
    if (budget === null) return state.tokensAtCreate
    return state.tokensAtCreate ?? this.tokensAt(session, true)
  }

  /** Resolve the active-work baseline an edit retains, by the same rule as its token baseline. */
  private editWorkMsBaseline(session: Session, state: GoalProjection, budget: number | null): number | undefined {
    if (budget === null) return state.workMsAtCreate
    return state.workMsAtCreate ?? this.workMsAt(session, true)
  }

  /**
   * Pause an active goal and disarm automatic continuation.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the paused view.
   */
  @Remote('pause')
  pause(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed')
  }

  /**
   * Resume and arm a stopped goal, or rearm an active goal after a
   * session-start edge, while its round budget still has capacity.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the active view.
   */
  @Remote('resume')
  resume(agent: Agent, ref: GoalRef): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) {
      throw this.transitionError(current, 'resume', resumable)
    }
    if (current.phase === 'active' && runtime.activation === 'armed') {
      throw new GoalError(`goal "${current.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION')
    }
    if (roundsExhausted(current, currentState.roundsStarted)) {
      throw new GoalError(
        `goal "${current.id}" exhausted ${String(current.maxGoalRounds)} goal rounds; raise or clear maxGoalRounds before resuming`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    const exhausted = exhaustedBudget(
      current,
      this.usedTokens(agent.session, currentState),
      this.usedWorkMs(agent.session, currentState),
    )
    if (exhausted !== null) {
      throw new GoalError(
        `goal "${current.id}" exhausted its ${exhausted === 'tokens' ? 'token' : 'active-work'} budget; `
        + `raise maxGoal${exhausted === 'tokens' ? 'Tokens' : 'WorkMs'} before resuming`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    return this.commitCurrent(agent, currentState, runtime, 'resume', this.withPhase(current, 'active'), 'armed')
  }

  /**
   * Mark a current non-complete goal complete and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the completed view.
   */
  @Remote('complete')
  complete(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(
      agent,
      ref,
      'complete',
      ['active', 'paused', 'blocked'],
      'complete',
      'disarmed',
    )
  }

  /**
   * Mark an active goal blocked and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param reason - policy-owned stable code and human-readable explanation.
   * @returns the blocked view with its durable reason.
   */
  block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (current.phase !== 'active') {
      throw this.transitionError(current, 'block', ['active'])
    }
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      'block',
      { ...this.withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) },
      'disarmed',
    )
  }

  /**
   * Clear the current goal while retaining a durable tombstone and history.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the tombstone ref whose revision is one past the cleared snapshot.
   */
  @Remote('clear')
  clear(agent: Agent, ref: GoalRef): GoalRef {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 }
    const change: GoalClearChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.nextMutationTime(currentState),
    }
    this.commit(agent, runtime, change, 'disarmed')
    return { ...tombstone }
  }

  /** Resolve the durable and process-local state used by a mutation. */
  private prepareMutation(agent: Agent): readonly [GoalProjection | null, GoalRuntimeState] {
    this.assertLive(agent)
    return [this.state(agent.session), this.runtimeState(agent.session)]
  }

  /** Reject stale or missing current-state refs. */
  private expectCurrent(state: GoalProjection | null, ref: GoalRef): GoalProjection {
    if (state === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    const current = state.goal
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'GOAL_STALE_REVISION',
      )
    }
    return state
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new GoalError(`agent "${agent.id}" is not live in this registry`, 'GOAL_AGENT_NOT_LIVE')
    }
  }

  /** Read the current durable projection maintained by the registry. */
  private state(session: Session): GoalProjection | null {
    const state = this.ctx.sessionProjections.stateOf(session, 'goal')
    if (state === undefined) throw new Error('goal projection is not registered')
    if (state.failure !== null) throw new Error(state.failure)
    return state.current
  }

  /** Return the process-local activation state, initially disarmed. */
  private runtimeState(session: Session): GoalRuntimeState {
    let runtime = this.runtimeStates.get(session)
    if (runtime !== undefined) return runtime
    runtime = {
      activation: 'disarmed',
      pendingActivation: undefined,
    }
    this.runtimeStates.set(session, runtime)
    return runtime
  }

  /** Publish one process-local activation edge when it actually changes. */
  private setActivation(session: Session, activation: GoalActivation): void {
    const runtime = this.runtimeState(session)
    if (runtime.activation === activation) return
    runtime.activation = activation
    const state = this.ctx.sessionProjections.stateOf(session, 'goal')
    /* v8 ignore next -- static inject requires the projection registry before this service activates. */
    if (state === undefined) return
    if (state.failure !== null) return
    const goal = this.view(session, state.current, runtime)
    this.ctx.emit('goal/activation-changed', {
      sessionId: session.id,
      ...goal === undefined ? {} : {
        goal: {
          id: goal.id,
          revision: goal.revision,
          activation: goal.activation,
        },
      },
    })
  }

  /** Build a new revision with one replacement phase. */
  private withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
      maxGoalTokens: current.maxGoalTokens,
      maxGoalWorkMs: current.maxGoalWorkMs,
    }
  }

  /** Shared validated phase transition. */
  private transition(
    agent: Agent,
    ref: GoalRef,
    operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
  ): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (!allowed.includes(current.phase)) throw this.transitionError(current, operation, allowed)
    return this.commitCurrent(agent, currentState, runtime, operation, this.withPhase(current, phase), activation)
  }

  /** Render a stable invalid-transition error. */
  private transitionError(current: GoalSnapshot, operation: GoalOperation, allowed: readonly GoalPhase[]): GoalError {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }

  /** Commit a mutation that retains the current goal's derived counters/times. */
  private commitCurrent(
    agent: Agent,
    state: GoalProjection,
    runtime: GoalRuntimeState,
    operation: Exclude<GoalOperation, 'create' | 'clear'>,
    goal: GoalSnapshot,
    activation: GoalActivation,
    counters: GoalCounters = state,
  ): GoalView {
    return this.commitSnapshot(
      agent,
      runtime,
      operation,
      goal,
      counters,
      state.createdAt,
      this.nextMutationTime(state),
      activation,
    )
  }

  /** Clamp a current goal's next timestamp across backward wall-clock movement. */
  private nextMutationTime(state: GoalProjection): number {
    return Math.max(Date.now(), state.updatedAt)
  }

  /** Build and commit one full-snapshot mutation. */
  private commitSnapshot(
    agent: Agent,
    runtime: GoalRuntimeState,
    operation: Exclude<GoalOperation, 'clear'>,
    goal: GoalSnapshot,
    counters: GoalCounters,
    createdAt: number,
    updatedAt: number,
    activation: GoalActivation,
  ): GoalView {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted: counters.roundsStarted,
      ...counters.tokensAtCreate === undefined ? {} : { tokensAtCreate: counters.tokensAtCreate },
      ...counters.workMsAtCreate === undefined ? {} : { workMsAtCreate: counters.workMsAtCreate },
      createdAt,
      updatedAt,
    }
    this.commit(agent, runtime, change, activation)
    // Read the committed projection back so mutation results and `get()` derive
    // usage, exhaustion, and timestamps in one place.
    const committed = this.view(agent.session, this.state(agent.session), runtime)
    /* v8 ignore next -- the mutation just committed a current goal. */
    if (committed === undefined) throw new Error('goal mutation committed without a current goal')
    return committed
  }

  /** Commit one mutation into the goal log and live event stream. */
  private commit(agent: Agent, runtime: GoalRuntimeState, change: GoalChangeMeta, activation: GoalActivation): void {
    const ref = goalChangeRef(change)
    runtime.pendingActivation = { offset: agent.session.seq, activation }
    try {
      const event = agent.session.append('goal/change', change)
      /* v8 ignore next -- Session.append returns the event committed at the pre-append seq. */
      if (SessionSeq(runtime.pendingActivation.offset) === event.seq) runtime.activation = activation
    } finally {
      runtime.pendingActivation = undefined
    }
    const goal = this.view(agent.session, this.state(agent.session), runtime)
    const notification: GoalChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...goal === undefined ? {} : { goal },
    }
    agentEvents(this.ctx, agent).emit('goal/changed', { change: notification })
  }

  /** Build a detached current view. */
  private view(session: Session, state: GoalProjection | null, runtime: GoalRuntimeState): GoalView | undefined {
    if (state === null) return undefined
    const tokensUsed = this.usedTokens(session, state)
    const workMsUsed = this.usedWorkMs(session, state)
    return {
      ...state.goal,
      roundsStarted: state.roundsStarted,
      tokensUsed,
      workMsUsed,
      exhaustedBudget: exhaustedBudget(state.goal, tokensUsed, workMsUsed),
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      activation: runtime.activation,
    }
  }

  /**
   * Read one session's cumulative provider tokens.
   * @param session - session whose durable usage is read.
   * @param required - reject an unmetered deployment instead of reporting absence.
   * @returns the summed disjoint usage buckets, or `undefined` when no token projection is registered.
   * @throws {@link GoalError} when `required` and the deployment mounts no token accounting.
   */
  private tokensAt(session: Session, required: boolean): number | undefined {
    const state = this.ctx.sessionProjections.stateOf(session, 'tokenUsage')
    if (state !== undefined) {
      const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = state.totals
      return uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    }
    if (!required) return undefined
    throw new GoalError(
      'a token budget requires the tokenUsage projection; mount @deepseek-ai/dsh-token-meter',
      'GOAL_BUDGET_UNMETERED',
    )
  }

  /**
   * Read one session's cumulative active model-and-tool milliseconds.
   * @param session - session whose durable statistics are read.
   * @param required - reject an unmetered deployment instead of reporting absence.
   * @returns the summed model and tool wall time, or `undefined` when no statistics projection is registered.
   * @throws {@link GoalError} when `required` and the deployment mounts no session statistics.
   */
  private workMsAt(session: Session, required: boolean): number | undefined {
    const stats = this.ctx.sessionProjections.stateOf(session, 'sessionStats')
    if (stats !== undefined) return stats.llmMs + stats.toolMs
    if (!required) return undefined
    throw new GoalError(
      'an active-work budget requires the sessionStats projection; mount @deepseek-ai/dsh-session-stats',
      'GOAL_BUDGET_UNMETERED',
    )
  }

  /**
   * Tokens spent under one goal.
   * @param session - session carrying the live accounting.
   * @param counters - goal counters supplying the create-time baseline.
   * @returns the spent total, or null when either side of the comparison is unmeasured.
   */
  private usedTokens(session: Session, counters: GoalCounters): number | null {
    const total = this.tokensAt(session, false)
    const baseline = counters.tokensAtCreate
    return total === undefined || baseline === undefined ? null : Math.max(0, total - baseline)
  }

  /**
   * Active model-and-tool time spent under one goal.
   * @param session - session carrying the live accounting.
   * @param counters - goal counters supplying the create-time baseline.
   * @returns the spent milliseconds, or null when either side of the comparison is unmeasured.
   */
  private usedWorkMs(session: Session, counters: GoalCounters): number | null {
    const total = this.workMsAt(session, false)
    const baseline = counters.workMsAtCreate
    return total === undefined || baseline === undefined ? null : Math.max(0, total - baseline)
  }

  /**
   * Create one Goal through the remote boundary.
   * @param agent - exact live Agent resolved from the wire identity.
   * @param request - objective and optional round cap.
   * @returns the created Goal identity.
   */
  @Remote('create')
  remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    const view = this.create(agent, request)
    return { ref: { id: view.id, revision: view.revision } }
  }
}

export default GoalService
