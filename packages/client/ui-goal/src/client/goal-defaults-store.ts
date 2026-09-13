/**
 * Goal-limits row slot store: a mirror of the `goal` settings namespace's
 * resolved section. The plugin's apply-world scope subscription is the only
 * writer; the row component reads through props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Store state mirrored from the goal settings snapshot. */
export interface GoalDefaultsRowState {
  /** Resolved default round cap; null before the first accepted section. */
  rounds: number | null
  /** Resolved default token ceiling, or null while unbounded. */
  tokens: number | null
  /** Resolved default active-work ceiling in milliseconds, or null while unbounded. */
  workMs: number | null
  /** Namespace revision; -1 until the first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type GoalDefaultsRowActions = {
  sync: (
    draft: GoalDefaultsRowState,
    next: Pick<GoalDefaultsRowState, 'rounds' | 'tokens' | 'workMs'>,
    revision: number,
  ) => void
}

/**
 * Declares the goal-limits row state and write surface.
 * @returns the store handle.
 */
export function createGoalDefaultsRowStore(): EngineStoreHandle<GoalDefaultsRowState, GoalDefaultsRowActions> {
  return defineStore({
    init: (): GoalDefaultsRowState => ({ rounds: null, tokens: null, workMs: null, revision: -1 }),
    actions: {
      sync: (d, next, revision) => {
        if (revision <= d.revision) return
        d.rounds = next.rounds
        d.tokens = next.tokens
        d.workMs = next.workMs
        d.revision = revision
      },
    },
  })
}
