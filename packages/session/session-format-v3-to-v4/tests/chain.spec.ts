/** Chain-level evidence for the v3 -> v4 edge: multi-hop ceilings, refusals, and determinism. */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalog, SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { releasedV3SessionFormatCodec, sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header, releasedV4SessionFormatCodec, restoreReleasedV4Artifact, sessionFormatV3ToV4 } from '../src/index.ts'

/** The generated catalog's shape: every released codec, all four adjacent edges, v4 current. */
function chainCatalog() {
  return createSessionFormatCatalog({
    currentVersion: SESSION_FORMAT_VERSION,
    codecs: [
      releasedV0SessionFormatCodec,
      releasedV1SessionFormatCodec,
      releasedV2SessionFormatCodec,
      releasedV3SessionFormatCodec,
      releasedV4SessionFormatCodec,
    ],
    currentEncoder: releasedV4SessionFormatCodec,
    migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3, sessionFormatV3ToV4],
    restoreCurrent: artifact => restoreReleasedV4Artifact(artifact, new Set()),
    restoreTransformedCurrent: artifact => restoreReleasedV4Artifact(artifact, new Set()),
    restoreCurrentHeader(value) { assertReleasedV4Header(value); return value },
  })
}

const catalog = chainCatalog()
/** The goal snapshot every released predecessor admits and the current writer still emits. */
const snapshot: SessionFormatJsonObject = { id: 'goal-1', revision: 1, objective: 'ship the ceilings', phase: 'active', maxGoalRounds: 64 }

/** One standalone goal change as every released generation from v0 through v3 stores it. */
function goalChange(seq: number, goal: SessionFormatJsonObject = snapshot): SessionFormatEvent {
  return {
    type: 'goal/change',
    seq,
    time: 42,
    data: { kind: 'goal/change', version: 1, operation: 'create', goal, roundsStarted: 0, createdAt: 5, updatedAt: 6 },
  }
}

/** The inherited end-seed marker a seeded source states explicitly. */
function endSeed(seq: number, time: number): SessionFormatEvent {
  return { type: 'session/end-seed', seq, time, data: { inherited: true } }
}

/** Restore one physical record through every adjacent edge into the current logical artifact. */
function restore(physical: SessionFormatJsonObject, rows: readonly SessionFormatEvent[]): SessionFormatArtifact {
  const reader = catalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
  for (const row of rows) reader.decodeRow(row)
  return reader.finish()
}

describe('released Session format chain', () => {
  const goalChainPhysical = { type: 'session', version: 0, id: 'goal-chain', createdAt: 1, parentSession: 'parent', seedLength: 3, delegationDepth: 0 }
  const goalChainRows: SessionFormatEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    goalChange(2),
    { type: 'feedback/record', seq: 3, time: 4, data: { text: 'local' } },
  ]

  it('migrates a v0 goal change through every edge to v4 with explicit ceilings', () => {
    const before = JSON.stringify({ goalChainPhysical, goalChainRows })
    const artifact = restore(goalChainPhysical, goalChainRows)
    expect(artifact.header).toMatchObject({
      version: SESSION_FORMAT_VERSION, id: 'goal-chain', parentSession: 'parent', isSeeded: true, delegationDepth: 0,
    })
    // The v0 -> v1 edge synthesizes the end-seed marker; the v2 -> v3 edge inserts the system head.
    expect(artifact.events.map(event => event.type)).toEqual(
      ['turn/start', 'step/start', 'system/message', 'goal/change', 'session/end-seed', 'feedback/record'],
    )
    // The three seeded rows plus the inserted system head are the inherited prefix.
    expect(artifact.inheritedEventCount).toBe(4)
    const change = artifact.events.find(event => event.type === 'goal/change')!
    expect(change.seq).toBeLessThan(artifact.inheritedEventCount)
    expect(change.data).toEqual({
      kind: 'goal/change', version: 1, operation: 'create',
      goal: { ...snapshot, maxGoalTokens: null, maxGoalWorkMs: null },
      roundsStarted: 0, createdAt: 5, updatedAt: 6,
    })
    expect(JSON.stringify({ goalChainPhysical, goalChainRows })).toBe(before)
  })

  it.each([1, 2])('restores a seeded v%i goal change through every adjacent edge with explicit ceilings', (version) => {
    const physical = version === 1
      ? { type: 'session', version, id: 'seeded-chain', createdAt: 1, parentSession: 'parent', seedLength: 1, delegationDepth: 0 }
      : { type: 'session', version, id: 'seeded-chain', createdAt: 1, parentSession: 'parent', isSeeded: true, delegationDepth: 0 }
    const rows = version === 1 ? [goalChange(0)] : [goalChange(0), endSeed(1, 2)]
    const before = JSON.stringify({ physical, rows })
    const artifact = restore(physical, rows)
    expect(artifact.header).toMatchObject({ version: SESSION_FORMAT_VERSION, id: 'seeded-chain', isSeeded: true })
    expect(artifact.inheritedEventCount).toBe(1)
    expect(artifact.events.at(-1)).toEqual({ type: 'session/end-seed', seq: 1, time: version === 1 ? 42 : 2, data: { inherited: true } })
    expect(artifact.events[0]!.data).toEqual({
      kind: 'goal/change', version: 1, operation: 'create',
      goal: { ...snapshot, maxGoalTokens: null, maxGoalWorkMs: null },
      roundsStarted: 0, createdAt: 5, updatedAt: 6,
    })
    expect(JSON.stringify({ physical, rows })).toBe(before)
  })

  it('produces identical output for repeated restores of the same input', () => {
    const before = JSON.stringify({ goalChainPhysical, goalChainRows })
    const first = restore(goalChainPhysical, goalChainRows)
    const second = restore(goalChainPhysical, goalChainRows)
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(JSON.stringify({ goalChainPhysical, goalChainRows })).toBe(before)
  })

  it('keeps two concurrent stages independent', () => {
    const seeded = { version: 3, id: 'seeded-stage', createdAt: 1, isSeeded: true, parentSession: 'parent', delegationDepth: 0 }
    const local = { version: 3, id: 'local-stage', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const a = sessionFormatV3ToV4.createStage({
      sourceHeader: seeded, targetHeader: sessionFormatV3ToV4.migrateHeader(seeded), sourceInheritedEventCount: undefined, sourceKind: 'decoded',
    })
    const b = sessionFormatV3ToV4.createStage({
      sourceHeader: local, targetHeader: sessionFormatV3ToV4.migrateHeader(local), sourceInheritedEventCount: 0, sourceKind: 'decoded',
    })
    expect(a.headerInheritedEventCount).toBeUndefined()
    expect(b.headerInheritedEventCount).toBe(0)
    const collectorA = new SessionFormatEventCollector()
    const collectorB = new SessionFormatEventCollector()
    b.transformEvent(goalChange(0, { ...snapshot, id: 'goal-b' }), collectorB)
    a.transformEvent(goalChange(0), collectorA)
    b.transformEvent({ type: 'feedback/record', seq: 1, time: 2, data: { text: 'local' } }, collectorB)
    a.transformEvent(endSeed(1, 2), collectorA)
    expect(a.headerInheritedEventCount).toBeUndefined()
    expect(b.headerInheritedEventCount).toBe(0)
    expect(collectorA.values.map(event => event.type)).toEqual(['goal/change', 'session/end-seed'])
    expect(collectorB.values.map(event => event.type)).toEqual(['goal/change', 'feedback/record'])
    const goalA = (collectorA.values[0]!.data as SessionFormatJsonObject)['goal'] as SessionFormatJsonObject
    const goalB = (collectorB.values[0]!.data as SessionFormatJsonObject)['goal'] as SessionFormatJsonObject
    expect(goalA).toMatchObject({ id: 'goal-1', maxGoalRounds: 64, maxGoalTokens: null, maxGoalWorkMs: null })
    expect(goalB).toMatchObject({ id: 'goal-b', maxGoalRounds: 64, maxGoalTokens: null, maxGoalWorkMs: null })
    expect(collectorA.values.at(-1)).toEqual(endSeed(1, 2))
    expect(a.finish(collectorA)).toBe(1)
    expect(b.finish(collectorB)).toBe(0)
  })

  it('refuses an unknown required event at v3 admission', () => {
    const header = { type: 'session', version: 3, id: 'v3-admission', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const required = { type: 'tool/code-dispatch-start', seq: 0, time: 1, data: { rootCallId: 'root' } }
    const before = JSON.stringify(required)
    const refused = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    expect(() => { refused.decodeRow(required) }).toThrow(/unknown event type/)
    expect(JSON.stringify(required)).toBe(before)
    const admitted = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    admitted.decodeRow({ ...required, ignorable: true })
    expect(admitted.finish().events).toEqual([{ ...required, ignorable: true }])
    const deferred = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    deferred.decodeRow({ type: 'external/future', seq: 0, time: 1, data: null })
    expect(() => { deferred.finish() }).toThrow(/unknown event type/)
  })

  it('refuses a malformed goal change payload instead of guessing', () => {
    const header = { type: 'session', version: 2, id: 'malformed', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const malformed = goalChange(0, { ...snapshot, maxGoalRounds: 'many' })
    const before = JSON.stringify(malformed)
    const refused = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    expect(() => { refused.decodeRow(malformed) }).toThrow(/refuses this format v2 Session: goal\/change 0 goal maxGoalRounds/)
    expect(JSON.stringify(malformed)).toBe(before)
    // A clear tombstone carries no snapshot: the edge leaves it byte-identical instead of inventing ceilings.
    const clear = {
      type: 'goal/change', seq: 0, time: 1,
      data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal-1', revision: 1 }, clearedAt: 5 },
    }
    expect(restore(header, [clear]).events).toEqual([clear])
  })

  it('does not fall back to a predecessor when a v4 record is present', () => {
    const header = { type: 'session', version: SESSION_FORMAT_VERSION, id: 'current-record', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const rows = [goalChange(0)]
    const before = JSON.stringify({ header, rows })
    expect(catalog.readHeader(header)).toMatchObject({
      status: 'current', storedVersion: SESSION_FORMAT_VERSION, targetVersion: SESSION_FORMAT_VERSION,
    })
    const artifact = restore(header, rows)
    expect(artifact.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(artifact.events).toEqual(rows)
    // The identical record stored at v3 is rewritten, so the difference is the stored generation, not the payload.
    const migrated = restore({ ...header, version: 3 }, rows)
    const goal = ((migrated.events[0]!.data as SessionFormatJsonObject)['goal']) as SessionFormatJsonObject
    expect(goal).toMatchObject({ maxGoalRounds: 64, maxGoalTokens: null, maxGoalWorkMs: null })
    expect(JSON.stringify({ header, rows })).toBe(before)
  })
})
