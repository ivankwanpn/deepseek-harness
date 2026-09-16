import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { sessionFormatV3ToV4, restoreReleasedV4Artifact } from '../src/index.ts'

const header: SessionFormatHeader = { version: 3, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const event = (type: string, data: SessionFormatEvent['data'], seq: number): SessionFormatEvent => ({ type, seq, time: 42, data })

function migrate(events: readonly SessionFormatEvent[]): SessionFormatArtifact {
  const target = sessionFormatV3ToV4.migrateHeader(header)
  const stage = sessionFormatV3ToV4.createStage({
    sourceHeader: header, targetHeader: target, sourceInheritedEventCount: 0, sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  for (const e of events) stage.transformEvent(e, collector)
  return restoreReleasedV4Artifact({ header: target, inheritedEventCount: stage.finish(collector), events: collector.values }, new Set())
}

const goalChange = (goal: SessionFormatJsonObject): SessionFormatEvent => event('goal/change', {
  kind: 'goal/change', version: 1, operation: 'create', goal, roundsStarted: 0, createdAt: 5,
}, 0)

describe('format v3 -> v4 migration', () => {
  it('materializes absent ceilings as explicit nulls', () => {
    const artifact = migrate([goalChange({ id: 'g1', revision: 1, objective: 'o', phase: 'active', maxGoalRounds: 256 })])
    const goal = ((artifact.events[0]!.data as SessionFormatJsonObject)['goal']) as SessionFormatJsonObject
    expect(goal['maxGoalRounds']).toBe(256)
    expect(goal['maxGoalTokens']).toBeNull()
    expect(goal['maxGoalWorkMs']).toBeNull()
  })

  it('preserves present ceilings and unrelated events byte-for-byte', () => {
    const unrelated = event('turn/start', { turn: 1 }, 0)
    const artifact = migrate([unrelated])
    expect(artifact.events[0]).toEqual(unrelated)
    const withBudgets = migrate([goalChange({
      id: 'g1', revision: 1, objective: 'o', phase: 'active', maxGoalRounds: null, maxGoalTokens: 5, maxGoalWorkMs: 6,
    })])
    const goal = ((withBudgets.events[0]!.data as SessionFormatJsonObject)['goal']) as SessionFormatJsonObject
    expect(goal).toMatchObject({ maxGoalRounds: null, maxGoalTokens: 5, maxGoalWorkMs: 6 })
  })

  it('refuses a required predecessor dispatch tag at the stage and passes an ignorable one unchanged', () => {
    const target = sessionFormatV3ToV4.migrateHeader(header)
    const stage = sessionFormatV3ToV4.createStage({
      sourceHeader: header, targetHeader: target, sourceInheritedEventCount: 0, sourceKind: 'decoded',
    })
    const collector = new SessionFormatEventCollector()
    const required = event('tool/code-dispatch-start', { rootCallId: 'r' }, 0)
    expect(() => { stage.transformEvent(required, collector) }).toThrow(/unknown event type/)
    expect(collector.values).toEqual([])
    const ignorable = { ...event('tool/code-dispatch-start', { rootCallId: 'r' }, 0), ignorable: true }
    stage.transformEvent(ignorable, collector)
    expect(collector.values[0]).toBe(ignorable)
  })
})
