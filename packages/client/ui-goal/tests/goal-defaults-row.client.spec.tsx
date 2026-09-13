// @vitest-environment jsdom
/** GoalDefaultsRow behavior: the three resolved values render, a valid draft
 * writes through the injected face, a rejected draft reports the invalid copy
 * and writes nothing, and an emptied field runs the clear path. */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { GoalDefaultsRow } from '../src/client/GoalDefaultsRow.tsx'
import type { GoalDefaultsRowComponentProps } from '../src/client/GoalDefaultsRow.tsx'
import { createGoalDefaultsRowStore } from '../src/client/goal-defaults-store.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'defaults.title': 'Goal limits',
  'defaults.description': 'Applied to new goals.',
  'defaults.rounds.label': 'Round limit',
  'defaults.rounds.hint': 'Maximum automatic continuation rounds.',
  'defaults.tokens.label': 'Token budget',
  'defaults.tokens.hint': 'Provider tokens available to the whole goal.',
  'defaults.work.label': 'Active work (ms)',
  'defaults.work.hint': 'Model and tool milliseconds available to the whole goal.',
  'defaults.invalid': 'Enter a whole number greater than zero.',
}

/** Empty global standard-kit hooks (the row reads none of them). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<GoalDefaultsRowComponentProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: GoalDefaultsRowComponentProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function mount(seed: { rounds: number | null; tokens: number | null; workMs: number | null }) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createGoalDefaultsRowStore().create()
  store.actions.sync(seed, 0)
  const setLimit = vi.fn()
  const clearLimit = vi.fn()
  const props: GoalDefaultsRowComponentProps = {
    useSessions: emptySessions(),
    useSessionPendingInteraction,
    usePanelInfo, useResource,
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setLimit, clearLimit,
  }
  render(<GoalDefaultsRow {...props} />)
  return { store, setLimit, clearLimit }
}

const input = (name: string): HTMLInputElement => screen.getByLabelText(name) as HTMLInputElement

describe('GoalDefaultsRow', () => {
  it('renders the resolved limits and leaves an unbounded budget empty', () => {
    mount({ rounds: 256, tokens: null, workMs: 21_600_000 })
    expect(screen.getByText('Goal limits')).toBeDefined()
    expect(input('Round limit').value).toBe('256')
    expect(input('Token budget').value).toBe('')
    expect(input('Active work (ms)').value).toBe('21600000')
  })

  it('writes a valid draft and shows the persisted value, not the keystroke echo', () => {
    const { store, setLimit } = mount({ rounds: 256, tokens: null, workMs: null })
    fireEvent.focus(input('Round limit'))
    fireEvent.change(input('Round limit'), { target: { value: '40' } })
    expect(setLimit).toHaveBeenCalledWith('defaultMaxGoalRounds', 40)
    // Until the section commits, the field shows the draft under edit.
    expect(input('Round limit').value).toBe('40')
    fireEvent.blur(input('Round limit'))
    expect(input('Round limit').value).toBe('256')
    act(() => { store.actions.sync({ rounds: 40, tokens: null, workMs: null }, 1) })
    expect(input('Round limit').value).toBe('40')
  })

  it('reports a rejected draft and writes nothing', () => {
    const { setLimit, clearLimit } = mount({ rounds: 256, tokens: null, workMs: null })
    fireEvent.focus(input('Token budget'))
    fireEvent.change(input('Token budget'), { target: { value: '0' } })
    expect(setLimit).not.toHaveBeenCalled()
    expect(screen.getByText('Enter a whole number greater than zero.')).toBeDefined()
    expect(input('Token budget').getAttribute('aria-invalid')).toBe('true')
    fireEvent.blur(input('Token budget'))
    // A rejected draft is not a clear either: it reverts to the persisted value.
    expect(clearLimit).not.toHaveBeenCalled()
    expect(screen.getByText('Applied to new goals.')).toBeDefined()
  })

  it('clears a field left empty so it re-inherits the composition layer', () => {
    const { clearLimit, setLimit } = mount({ rounds: 256, tokens: 5_000, workMs: null })
    fireEvent.focus(input('Token budget'))
    fireEvent.change(input('Token budget'), { target: { value: '' } })
    expect(setLimit).not.toHaveBeenCalled()
    fireEvent.blur(input('Token budget'))
    expect(clearLimit).toHaveBeenCalledWith('defaultMaxGoalTokens')
  })
})
