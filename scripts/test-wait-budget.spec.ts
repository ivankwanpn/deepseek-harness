import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { COVERAGE_TEST_TIMEOUT_ENV, LANE_TEST_BUDGET_FALLBACK_MS, laneTestBudgetMs } from './coverage-partitions.ts'
import { installWaitBudget, TEST_WAIT_BUDGET_SETUP_FILE, waitOptionsWithBudget } from './test-wait-budget.ts'
import type { WaitUtils } from './test-wait-budget.ts'

/** A `vi`-shaped recorder; the installer replaces exactly these two properties. */
function recordingUtils(): { utils: WaitUtils; calls: unknown[][] } {
  const calls: unknown[][] = []
  const record = async (...args: unknown[]): Promise<unknown> => calls.push(args)
  return { utils: { waitFor: record, waitUntil: record } as unknown as WaitUtils, calls }
}

describe('lane wait budget', () => {
  it('resolves the exported override first and the lane fallback second', () => {
    expect(laneTestBudgetMs({ [COVERAGE_TEST_TIMEOUT_ENV]: '15000' })).toBe(15_000)
    expect(laneTestBudgetMs({})).toBe(LANE_TEST_BUDGET_FALLBACK_MS)
    expect(() => laneTestBudgetMs({ [COVERAGE_TEST_TIMEOUT_ENV]: '0' }))
      .toThrow(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer`)
  })

  it('supplies the budget to a call that states none', () => {
    expect(waitOptionsWithBudget(undefined, 12_345)).toEqual({ timeout: 12_345 })
    expect(waitOptionsWithBudget({ interval: 100 }, 12_345)).toEqual({ interval: 100, timeout: 12_345 })
  })

  it('leaves a budget the call states, in either accepted form', () => {
    const stated = { timeout: 20, interval: 5 }
    expect(waitOptionsWithBudget(stated, 12_345)).toBe(stated)
    expect(waitOptionsWithBudget(40, 12_345)).toBe(40)
  })

  it('defaults both wait utilities and forwards their own options through', async () => {
    const { utils, calls } = recordingUtils()
    installWaitBudget(utils, 12_345)
    await utils.waitFor(() => true)
    await utils.waitUntil(() => true, { timeout: 20 })
    expect(calls).toEqual([
      [expect.any(Function), { timeout: 12_345 }],
      [expect.any(Function), { timeout: 20 }],
    ])
  })

  // The lane-level proof that the mechanism runs in a real worker: this file's
  // `setupFiles` entry installed the budget, so a bare wait outlives the second
  // Vitest hardcodes. Without the installation it rejects after about 1000 ms.
  it('lets a bare wait outlive the second Vitest hardcodes', async () => {
    const started = Date.now()
    await vi.waitFor(() => {
      if (Date.now() - started < 1_500) throw new Error('still settling')
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
  })

  // Importing the module above installs the budget whether or not the lane wired
  // it, so the runtime case cannot see a missing `setupFiles` entry. The wiring
  // is what a new project, or a config that lists only the invariant host, breaks.
  it('is declared in every setupFiles slot of the unit lane', () => {
    const slots = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8')
      .match(/setupFiles: \[[^\]]*\]/g) ?? []
    // Guards the discovery itself: the root block and both projects declare one.
    expect(slots).toHaveLength(3)
    for (const slot of slots) expect(slot).toContain(TEST_WAIT_BUDGET_SETUP_FILE)
  })
})
