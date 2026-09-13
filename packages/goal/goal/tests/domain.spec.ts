/**
 * The round-cap vocabulary both the replay fold and the continuation driver
 * read. A goal created without a cap is unbounded in rounds; only a named cap
 * can be reached.
 */
import { describe, expect, it } from 'vitest'
import { roundWithinCap, roundsExhausted } from '@deepseek-ai/dsh-goal'
import type { GoalSnapshot } from '@deepseek-ai/dsh-goal'

const capped = (maxGoalRounds: number | null): Pick<GoalSnapshot, 'maxGoalRounds'> => ({ maxGoalRounds })

describe('goal round cap vocabulary', () => {
  it('reaches only a named cap', () => {
    expect(roundsExhausted(capped(2), 1)).toBe(false)
    expect(roundsExhausted(capped(2), 2)).toBe(true)
    expect(roundsExhausted(capped(2), 3)).toBe(true)
  })

  it('never reaches a null cap', () => {
    expect(roundsExhausted(capped(null), 0)).toBe(false)
    expect(roundsExhausted(capped(null), 99)).toBe(false)
  })

  it('admits every round of an unbounded goal and no round past a named cap', () => {
    expect(roundWithinCap(capped(2), 2)).toBe(true)
    expect(roundWithinCap(capped(2), 3)).toBe(false)
    expect(roundWithinCap(capped(null), 99)).toBe(true)
  })
})
