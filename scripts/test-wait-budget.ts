/**
 * Give the lane's `vi.waitFor` and `vi.waitUntil` the case budget.
 *
 * Vitest reads no configuration for either one. Its utilities object exposes the
 * bare `waitFor(callback, options = {})`, which destructures `timeout = 1e3`, so
 * the lane's 922 waits that state no budget of their own were bounded by a
 * hardcoded second while the case around them ran on the lane's 90. A settling
 * wait that crosses a process, filesystem, or durable-log boundary then failed a
 * run the lane had already budgeted, and raising it meant editing every call
 * site instead of the lane.
 *
 * Installing the lane budget as their default is the same decision
 * `vitest.config.ts` makes for `testTimeout`, `hookTimeout`, and `expect.poll`,
 * for the one wait Vitest lets no config reach. A wait that states its own
 * timeout keeps it, so a case whose subject is a deadline still overrides the
 * lane exactly as it would through the case budget.
 * @module
 */

import { vi } from 'vitest'
import { laneTestBudgetMs } from './coverage-partitions.ts'

/** This module's path as a `setupFiles` entry, so its own wiring test names it once. */
export const TEST_WAIT_BUDGET_SETUP_FILE = './scripts/test-wait-budget.ts'

/** The two Vitest utilities whose hardcoded default this lane replaces. */
export type WaitUtils = Pick<typeof vi, 'waitFor' | 'waitUntil'>

/**
 * Apply one lane budget to a wait call's options.
 *
 * The numeric form of the second argument is a timeout, and an options object
 * that already carries one — including one built by an earlier installation —
 * is left untouched.
 * @param options - the call's second argument, as Vitest receives it.
 * @param budgetMs - the lane's per-test budget, in milliseconds.
 * @returns options carrying a timeout.
 */
export function waitOptionsWithBudget(options: unknown, budgetMs: number): unknown {
  if (typeof options === 'number') return options
  if (typeof options !== 'object' || options === null) return { timeout: budgetMs }
  return (options as { timeout?: unknown }).timeout === undefined ? { ...options, timeout: budgetMs } : options
}

/**
 * Install the lane's default timeout on the wait utilities.
 * @param utils - the Vitest utilities object to patch.
 * @param budgetMs - the lane's per-test budget, in milliseconds.
 */
export function installWaitBudget(utils: WaitUtils, budgetMs: number): void {
  const waitFor = utils.waitFor as unknown as (callback: unknown, options?: unknown) => Promise<unknown>
  const waitUntil = utils.waitUntil as unknown as (callback: unknown, options?: unknown) => Promise<unknown>
  const install = (original: (callback: unknown, options?: unknown) => Promise<unknown>) =>
    (callback: unknown, options?: unknown): Promise<unknown> =>
      original(callback, waitOptionsWithBudget(options, budgetMs))
  utils.waitFor = install(waitFor) as unknown as typeof utils.waitFor
  utils.waitUntil = install(waitUntil) as unknown as typeof utils.waitUntil
}

installWaitBudget(vi, laneTestBudgetMs())
