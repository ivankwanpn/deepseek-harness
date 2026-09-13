/**
 * Host-side vocabulary of the goal domain: live views, durable change
 * payloads, message attribution, replay folds, and the scoped `goal/changed`
 * event. Kept separate from ./types.ts (the pure client-safe outlet) because
 * these declarations pull dsh-agent, dsh-llm, and cordis into the program —
 * the one-program-per-side layout forbids that on client aggregates.
 * @module @deepseek-ai/dsh-goal
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalId, GoalRef, GoalSnapshot, GoalView } from './types.ts'

/** Goal state-changing verbs recorded in the durable source change. */
export type GoalOperation =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear'

/** Full-snapshot goal mutation committed by a durable `goal/change` event. */
export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  /**
   * Cumulative session token total at the create mutation, retained unchanged
   * by every later mutation. Absent exactly on goals created before budgets
   * existed; a change that names a token budget must carry it.
   */
  readonly tokensAtCreate?: number
  /** Cumulative session active model-and-tool milliseconds at the create mutation. */
  readonly workMsAtCreate?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Tombstone retained when the current goal is cleared. */
export interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}

/** Durable change union carried by the goal domain's own session event. */
export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta

/** Message attribution for admitted continuation rounds. */
export interface GoalMessageSource {
  readonly kind: 'goal'
  readonly goalId: GoalId
  readonly revision: number
  /** Positive admitted continuation round. */
  readonly round: number
  /**
   * Provider tokens spent under this goal when the round was admitted, absent
   * when the deployment meters no tokens. Recorded because the round prompt
   * shows this figure and an invariant re-renders that prompt from the log
   * alone, so every model-visible number must survive replay.
   */
  readonly tokensUsed?: number
  /** Active model-and-tool milliseconds spent under this goal when the round was admitted. */
  readonly workMsUsed?: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    goal: GoalMessageSource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation goal state or clear tombstone.
     */
    'goal/change': GoalChangeMeta
  }
}

/** Pure replay fold of durable goal facts. */
export interface FoldedGoal {
  /** Current goal, absent after a clear or before the first create. */
  readonly goal?: GoalSnapshot
  /** Highest admitted round for the current goal. */
  readonly roundsStarted: number
  /** Token baseline recorded at creation, absent without a current goal or a recorded baseline. */
  readonly tokensAtCreate?: number
  /** Active-work baseline recorded at creation, absent without a current goal or a recorded baseline. */
  readonly workMsAtCreate?: number
  /** Current goal creation time, absent without a current goal. */
  readonly createdAt?: number
  /** Current goal mutation time, absent without a current goal. */
  readonly updatedAt?: number
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef?: GoalRef
}

/** Live notification after one durable goal mutation commits. */
export interface GoalChanged {
  readonly operation: GoalOperation
  readonly ref: GoalRef
  /** Absent for a clear tombstone. */
  readonly goal?: GoalView
}

/**
 * Whether a goal's named round cap is spent, so no further round may be
 * admitted. A null cap leaves continuation unbounded by rounds; the resource
 * ceilings are then the only aggregate bound. The replay fold, the
 * continuation driver, and the projection-state check all read this one rule.
 * @param goal - snapshot carrying the cap.
 * @param roundsStarted - highest admitted round number for the same goal.
 * @returns true when another round would exceed a named cap.
 */
export function roundsExhausted(goal: Pick<GoalSnapshot, 'maxGoalRounds'>, roundsStarted: number): boolean {
  return goal.maxGoalRounds !== null && roundsStarted >= goal.maxGoalRounds
}

/**
 * Whether one admitted round number stays within the goal's named cap.
 * @param goal - snapshot carrying the cap.
 * @param round - the admitted round number under validation.
 * @returns true when the round is within the cap or the cap is null.
 */
export function roundWithinCap(goal: Pick<GoalSnapshot, 'maxGoalRounds'>, round: number): boolean {
  return goal.maxGoalRounds === null || round <= goal.maxGoalRounds
}

/** Stable error codes for rejected goal reads and mutations. */
export type GoalErrorCode =
  | 'GOAL_AGENT_NOT_LIVE'
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BUDGET'
  | 'GOAL_BUDGET_UNMETERED'
  | 'GOAL_BUDGET_EXCEEDS_LIMIT'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Goal mutation accepted by one live agent. The matching `goal/change`
     * session event has already committed. Listener failures are contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param payload.agent - agent whose session owns the goal.
     * @param payload.change - fresh current projection or clear tombstone.
     * @mode emit
     */
    'goal/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: GoalChanged }): void
  }
}
