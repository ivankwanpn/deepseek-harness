/** Streaming v3 → v4 migration: explicit goal-limit ceilings in goal change payloads. */

import { SessionFormatError, defineSessionFormatMigration, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent, SessionFormatEventRun, SessionFormatJsonObject,
  SessionFormatMigrationContext, SessionFormatMigrationStage, SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header, assertV3EventAdmission } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header } from './validation.ts'

/** Ceilings a v4 goal snapshot states explicitly; absence and null both meant unbounded in v3. */
const CEILINGS = ['maxGoalRounds', 'maxGoalTokens', 'maxGoalWorkMs'] as const

/** Materialize the goal-limit ceilings so every v4 goal change states all three. */
export const sessionFormatV3ToV4 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v3-to-v4',
  fromVersion: 3,
  toVersion: 4,
  migrateHeader(header) {
    assertReleasedV3Header(header)
    return { ...header, version: 4 }
  },
  createStage(input) { return new ReleasedV3ToV4Stage(input) },
  validateTargetHeader: assertReleasedV4Header,
})

class ReleasedV3ToV4Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private cut: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    assertReleasedV3Header(input.sourceHeader)
    // Cardinality is preserved, so the source cut is the target cut. A seeded
    // source states it only through its inherited end-seed marker; an unseeded
    // one is zero by construction, exactly as the v2 -> v3 stage models it.
    this.cut = input.sourceHeader.isSeeded ? undefined : 0
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    // V4 adds no envelope admission rule beyond V3, so the released V3 admission
    // is this edge's whole per-event contract.
    assertV3EventAdmission(event)
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) {
        throw new SessionFormatError('format v3 unseeded Session contains an inherited end-seed marker')
      }
      this.cut = event.seq
    }
    context.emitEvent(materializeCeilings(event))
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(_context: SessionFormatMigrationContext): number {
    const cut = sessionFormatCount(this.cut, 'format v3 inherited end-seed marker')
    if (this.input.sourceInheritedEventCount !== undefined && this.input.sourceInheritedEventCount !== cut) {
      throw new SessionFormatError('format v3 inherited end-seed marker disagrees with its source cut')
    }
    return cut
  }
}

/** Rewrite one event when it is a goal change carrying a snapshot; otherwise return it unchanged. */
function materializeCeilings(event: SessionFormatEvent): SessionFormatEvent {
  if (event.type !== 'goal/change' || !isSessionFormatJsonObject(event.data)) return event
  const data: SessionFormatJsonObject = event.data
  if (!isSessionFormatJsonObject(data['goal'])) return event
  const goal: SessionFormatJsonObject = data['goal']
  if (CEILINGS.every(name => goal[name] !== undefined)) return event
  const ceilings: Record<string, null> = {}
  for (const name of CEILINGS) if (goal[name] === undefined) ceilings[name] = null
  return { ...event, data: { ...data, goal: { ...goal, ...ceilings } } }
}
