// @vitest-environment jsdom
/**
 * ui-goal browser half on a real cordis Context with fake slots/api/
 * sessions faces: the plugin registers the GoalBar dock entry at
 * conversation.input.dock, the inject face's four verbs read the CAS ref
 * from the session's CURRENT projected value at call time (no fence — the
 * Remote method's compare-and-set is the guard), a missing projection short-circuits
 * to the no-current-goal error without touching the wire, and a Remote failure
 * reaches the strip verbatim. Registration disposal rides the
 * plugin fiber (HMR safety), and the node half stays inert.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GoalActivation, GoalId, GoalProjection, GoalView } from '@deepseek-ai/dsh-goal/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { GoalActivationSnapshot, GoalBarActions, GoalBarInjected } from '../src/client/slots.ts'
import type { GoalDefaultsRowInjected } from '../src/client/GoalDefaultsRow.tsx'
import { apply, inject } from '../src/client/index.ts'
import { GoalDock } from '../src/client/GoalBar.tsx'
import { zh } from '../src/client/locales.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId
const GOAL_ID = 'g-1' as GoalId

function makeProjection(revision = 3): GoalProjection {
  return {
    goal: {
      id: GOAL_ID,
      revision,
      objective: 'Ship it',
      phase: 'active',
      maxGoalRounds: 8,
      maxGoalTokens: null,
      maxGoalWorkMs: null,
    },
    roundsStarted: 1,
    createdAt: 10,
    updatedAt: 20,
  }
}

/** Boot the plugin over fake faces; Goal Remote methods record arguments and answer per the script. */
async function bench(options: {
  projection?: GoalProjection | null | undefined
  activation?: GoalActivation
  failWith?: RemoteFailure
  settings?: { defaultMaxGoalRounds?: number; defaultMaxGoalTokens?: number; defaultMaxGoalWorkMs?: number }
  settingsRevision?: number | null
  failWrites?: boolean
} = {}) {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  const sessions = {
    binding: (id: SessionId) => id === sid('missing') ? undefined : ({
      sessionId: id,
      session: {
        getSnapshot: () => ({ running: false }),
        subscribe: () => () => {},
        projections: { faceOf: (key: string) => ({
          getSnapshot: () => (key === 'goal' ? options.projection : undefined),
          subscribe: () => () => {},
        }) },
      },
      ctx,
    }),
  }
  ctx.provide('sessions', sessions)
  const conversationEvents = new UiConversation(ctx, sessions as never).events
  function answer<T>(method: string, value: T) {
    return (...args: unknown[]) => {
      calls.push({ method, args })
      if (options.failWith !== undefined) return Promise.resolve({ ok: false, error: options.failWith })
      return Promise.resolve({ ok: true, value })
    }
  }
  const ref = { id: 'g-1', revision: 3 }
  const goalView = (): GoalView | undefined => {
    if (options.projection === null || options.projection === undefined) return undefined
    return {
      ...options.projection.goal,
      roundsStarted: options.projection.roundsStarted,
      tokensUsed: null,
      workMsUsed: null,
      exhaustedBudget: null,
      createdAt: options.projection.createdAt,
      updatedAt: options.projection.updatedAt,
      activation: options.activation ?? 'armed',
    }
  }
  const goals = (prefix: string) => ({
    get: answer(`${prefix}/get`, goalView()),
    edit: answer(`${prefix}/edit`, { ref }),
    pause: answer(`${prefix}/pause`, { ref }),
    resume: answer(`${prefix}/resume`, { ref }),
    clear: answer(`${prefix}/clear`, ref),
  })
  let activeGoals: ReturnType<typeof goals> | undefined = goals('goals')
  class RemoteService extends Service {
    readonly activationListeners = new Set<(event: {
      sessionId: SessionId
      goal?: { id: string; revision: number; activation: GoalActivation }
    }) => void>()

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $on(_event: string, listener: (event: {
      sessionId: SessionId
      goal?: { id: string; revision: number; activation: GoalActivation }
    }) => void): () => void {
      this.activationListeners.add(listener)
      return () => { this.activationListeners.delete(listener) }
    }

    emitActivation(
      sessionId: SessionId,
      goal: { id: string; revision: number; activation: GoalActivation } | undefined,
    ): void {
      for (const listener of this.activationListeners) {
        listener({ sessionId, ...goal === undefined ? {} : { goal } })
      }
    }
  }
  const remote = new RemoteService(ctx)
  ctx.provide('remote.goals', {
    get get() { return activeGoals?.get },
    get edit() { return activeGoals?.edit },
    get pause() { return activeGoals?.pause },
    get resume() { return activeGoals?.resume },
    get clear() { return activeGoals?.clear },
  })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: {
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const settingsWrites: { field: string; value?: unknown }[] = []
  const settingsListeners = new Set<() => void>()
  const section = options.settings
  const revision = options.settings === undefined
    ? undefined
    : options.settingsRevision === null ? undefined : options.settingsRevision ?? 1
  const settleWrite = (): Promise<void> => options.failWrites === true
    ? Promise.reject(new Error('settings write refused'))
    : Promise.resolve()
  ctx.provide('settingsScope', {
    bind: () => ({
      getSnapshot: () => ({
        status: section === undefined ? 'unavailable' : 'ready',
        value: section,
        base: undefined,
        user: undefined,
        revision,
        writable: true,
        mode: 'host',
      }),
      subscribe: (listener: () => void) => {
        settingsListeners.add(listener)
        return () => { settingsListeners.delete(listener) }
      },
      set: (field: string, value: unknown) => {
        settingsWrites.push({ field, value })
        return settleWrite()
      },
      unset: (field: string) => {
        settingsWrites.push({ field })
        return settleWrite()
      },
    }),
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    settingsWrites,
    settingsListenerCount: () => settingsListeners.size,
    emitActivation: remote.emitActivation.bind(remote),
    definitions: () => conversationEvents.entries(),
    remountGoals: () => { activeGoals = goals('remounted-goals') },
    unmountGoals: () => { activeGoals = undefined },
    entry: () => {
      const entry = ctx.slots.entries('conversation.input.dock')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => GoalBarInjected) | undefined,
      }
    },
    chatEntry: () => ctx.slots.entries('conversation.chat.node')[0],
    defaultsEntry: () => ctx.slots.entries('settings.general.item')[0],
  }
}

describe('ui-goal browser plugin', () => {
  it('registers the GoalBar dock, command input Definition, and keyed Chat renderer', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toMatchObject({ id: 'goal', order: 10, locale: 'goal' })
    expect(b.entry()?.inject).toBeTypeOf('function')
    expect(() => b.entry()!.inject!(sid('missing'))).toThrow(/unavailable/)
    expect(b.definitions().map(definition => definition.kind)).toEqual(['goal-command-input'])
    expect(b.chatEntry()?.options).toMatchObject({ key: 'command-input' })
    expect(b.chatEntry()?.locale).toBe('goal')
  })

  it('verbs read the CAS ref from the current projected value at call time', async () => {
    const b = await bench({ projection: makeProjection(5) })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    // The strip forwards the Remote value verbatim; `answered` is the fake's
    // reply, unrelated to the CAS ref the call carries.
    const answered = { id: 'g-1', revision: 3 }
    expect(await verbs.onEdit('New objective')).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onPause()).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onResume()).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onClear()).toEqual({ ok: true, value: answered })
    expect(b.calls.map(c => c.method)).toEqual(['goals/edit', 'goals/pause', 'goals/resume', 'goals/clear'])
    const ref = { id: 'g-1', revision: 5 }
    expect(b.calls[0]?.args).toEqual(['s1', ref, { objective: 'New objective' }])
    expect(b.calls[1]?.args).toEqual(['s1', ref])
    expect(b.calls[2]?.args).toEqual(['s1', ref])
    expect(b.calls[3]?.args).toEqual(['s1', ref])
  })

  it('verbs read a remounted Remote namespace at action time', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    b.remountGoals()

    expect(await verbs.onPause()).toEqual({ ok: true, value: { ref: { id: 'g-1', revision: 3 } } })
    expect(b.calls).toMatchObject([{ method: 'remounted-goals/pause' }])
  })

  it('binds the activation hook and forwards only this session activation events', async () => {
    const b = await bench({ projection: makeProjection(), activation: 'disarmed' })
    await b.fiber.await()
    const injected = b.entry()!.inject!(sid('s1'))
    const source = injected.hooks.goalActivation
    const seen: unknown[] = []
    const dispose = source.subscribe(() => { seen.push(source.getSnapshot()) })
    await waitFor(() => {
      expect(source.getSnapshot()).toMatchObject({ id: 'g-1', revision: 3, activation: 'disarmed' })
    })
    expect(b.calls.at(-1)).toMatchObject({ method: 'goals/get', args: ['s1'] })

    b.emitActivation(sid('s2'), { id: 'g-1', revision: 3, activation: 'armed' })
    expect(source.getSnapshot().activation).toBe('disarmed')
    b.emitActivation(sid('s1'), { id: 'g-1', revision: 3, activation: 'armed' })
    expect(source.getSnapshot().activation).toBe('armed')
    dispose()
    expect(seen.length).toBeGreaterThan(0)
  })

  it('rejects every verb once the Remote namespace is gone', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    b.unmountGoals()

    // A missing namespace is an assembly fault, not a call outcome: this plugin
    // declares remote.goals in `inject`, so cordis disposes the dock entry along
    // with the namespace. Only a React closure that outlived that disposal can
    // reach these verbs, so no consumer-side guard renders it as an error.
    for (const verb of [() => verbs.onEdit('x'), () => verbs.onPause(), () => verbs.onResume(), () => verbs.onClear()]) {
      await expect(verb()).rejects.toThrow(TypeError)
    }
    expect(b.calls).toHaveLength(0)
  })

  it('a null or absent projection short-circuits every verb without touching the wire', async () => {
    for (const projection of [null, undefined]) {
      const b = await bench({ projection })
      await b.fiber.await()
      const verbs = b.entry()!.inject!(sid('s1'))
      for (const result of [await verbs.onEdit('x'), await verbs.onPause(), await verbs.onResume(), await verbs.onClear()]) {
        expect(result).toEqual({ ok: false, error: { code: 'no-current-goal', message: 'no current goal to mutate' } })
      }
      expect(b.calls).toHaveLength(0)
    }
  })

  it('forwards a Remote failure to the strip verbatim', async () => {
    const b = await bench({
      projection: makeProjection(),
      failWith: new RemoteError('gateway/internal', 'stale revision', {}),
    })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    expect(await verbs.onEdit('x')).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'stale revision' } })
  })

  it('drops the dock entry when the plugin fiber unloads (HMR safety)', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toBeDefined()
    expect(b.chatEntry()).toBeDefined()
    expect(b.definitions()).toHaveLength(1)
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.chatEntry()).toBeUndefined()
    expect(b.definitions()).toHaveLength(0)
  })

  it('registers the goal-limits row and routes its edits through the settings scope', async () => {
    const b = await bench({ settings: { defaultMaxGoalRounds: 256 } })
    await b.fiber.await()
    const entry = b.defaultsEntry()
    expect(entry?.options).toMatchObject({ id: 'goal-defaults', order: 13 })
    expect(entry?.locale).toBe('goal')
    expect(b.settingsListenerCount()).toBe(1)

    const sync = vi.fn()
    const injected = (entry?.inject as unknown as (
      actions: { sync: typeof sync },
    ) => GoalDefaultsRowInjected)({ sync })
    // The section is adopted at registration so the first render is never empty.
    expect(sync).toHaveBeenCalledWith({ rounds: 256, tokens: null, workMs: null }, 1)
    injected.setLimit('defaultMaxGoalRounds', 40)
    injected.clearLimit('defaultMaxGoalTokens')
    expect(b.settingsWrites).toEqual([
      { field: 'defaultMaxGoalRounds', value: 40 },
      { field: 'defaultMaxGoalTokens' },
    ])
  })

  it('withdraws the goal-limits row and its subscription with the plugin fiber', async () => {
    const b = await bench({ settings: { defaultMaxGoalRounds: 256 } })
    await b.fiber.await()
    expect(b.defaultsEntry()).toBeDefined()
    expect(b.settingsListenerCount()).toBe(1)
    await b.fiber.dispose()
    expect(b.defaultsEntry()).toBeUndefined()
    expect(b.settingsListenerCount()).toBe(0)
  })

  it('leaves the row empty until a section with a revision arrives', async () => {
    const absent = await bench()
    await absent.fiber.await()
    const absentSync = vi.fn()
    defaultsInject(absent)({ sync: absentSync })
    expect(absentSync).not.toHaveBeenCalled()

    const unresolved = await bench({ settings: { defaultMaxGoalRounds: 256 }, settingsRevision: null })
    await unresolved.fiber.await()
    const unresolvedSync = vi.fn()
    defaultsInject(unresolved)({ sync: unresolvedSync })
    expect(unresolvedSync).not.toHaveBeenCalled()
  })

  it('adopts a section that carries no limits at all', async () => {
    const b = await bench({ settings: {} })
    await b.fiber.await()
    const sync = vi.fn()
    defaultsInject(b)({ sync })
    expect(sync).toHaveBeenCalledWith({ rounds: null, tokens: null, workMs: null }, 1)
  })

  it('contains a refused settings write instead of rejecting the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = await bench({ settings: { defaultMaxGoalRounds: 256 }, failWrites: true })
    await b.fiber.await()
    const injected = defaultsInject(b)({ sync: vi.fn() })
    injected.setLimit('defaultMaxGoalRounds', 40)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('ui-goal: goal default write failed', expect.anything()) })
    warn.mockRestore()
  })
})

/**
 * Call the row's inject face with a stand-in action bag.
 * @param b - the bench whose registered row is under test.
 * @returns the injected face the row receives.
 */
function defaultsInject(
  b: Awaited<ReturnType<typeof bench>>,
): (actions: { sync: (next: unknown, revision: number) => void }) => GoalDefaultsRowInjected {
  return b.defaultsEntry()?.inject as unknown as (
    actions: { sync: (next: unknown, revision: number) => void },
  ) => GoalDefaultsRowInjected
}

describe('GoalDock adapter', () => {
  it('renders the projected goal snapshot and nothing for absent/null', () => {
    const projection = makeProjection()
    const useProjection = vi.fn(() => projection)
    const useGoalActivation = (
      selector: (snapshot: GoalActivationSnapshot) => unknown,
    ) => selector({ id: GOAL_ID, revision: 3, activation: 'armed' })
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true, value: undefined }),
      onPause: () => Promise.resolve({ ok: true, value: undefined }),
      onResume: () => Promise.resolve({ ok: true, value: undefined }),
      onClear: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const t = makeTranslate(zh, commonZh)
    const dockProps = (up: () => GoalProjection | null | undefined) =>
      ({ useProjection: up, useGoalActivation, ...actions, t }) as unknown as Parameters<typeof GoalDock>[0]
    const shown = render(<GoalDock {...dockProps(useProjection)} />)
    expect(shown.getByText('Ship it')).toBeTruthy()
    cleanup()

    const empty = render(<GoalDock {...dockProps(() => null)} />)
    expect(empty.container.firstChild).toBeNull()
    cleanup()

    const absent = render(<GoalDock {...dockProps(() => undefined)} />)
    expect(absent.container.firstChild).toBeNull()
  })

  it('matches activation by goal id and revision from the injected hook', () => {
    const projection = makeProjection()
    const useProjection = vi.fn(() => projection)
    const useGoalActivation = (
      selector: (snapshot: GoalActivationSnapshot) => unknown,
    ) => selector({ id: GOAL_ID, revision: 3, activation: 'disarmed' })
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true, value: undefined }),
      onPause: () => Promise.resolve({ ok: true, value: undefined }),
      onResume: () => Promise.resolve({ ok: true, value: undefined }),
      onClear: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const t = makeTranslate(zh, commonZh)
    const props = { useProjection, useGoalActivation, ...actions, t } as unknown as Parameters<typeof GoalDock>[0]
    const rendered = render(<GoalDock {...props} />)
    expect(rendered.getByText('未运行的目标')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复目标' })).toBeTruthy()
    expect(rendered.queryByRole('button', { name: '暂停目标' })).toBeNull()
  })
})

describe('ui-goal node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
