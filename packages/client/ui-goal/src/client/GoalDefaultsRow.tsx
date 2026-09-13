/**
 * Goal-limits row registered into the General section item slot: the three
 * deployment defaults for new goals. Each field commits on every valid
 * keystroke and clears when it is left empty, so an empty budget returns to
 * unbounded and an empty round limit returns to the built-in value. The
 * displayed value follows the persisted section, never the keystroke echo.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createGoalDefaultsRowStore } from './goal-defaults-store.ts'
import type { GoalKey } from './locales.ts'
import css from './GoalDefaultsRow.module.css'

/** The three `goal` settings fields the row edits. */
export type GoalLimitField = 'defaultMaxGoalRounds' | 'maxGoalTokens' | 'maxGoalWorkMs'

/** Injected business face: the two scope writes the row performs. */
export interface GoalDefaultsRowInjected {
  /** Write one limit into the user section. */
  setLimit: (field: GoalLimitField, value: number) => void
  /** Clear one limit so the field re-inherits the composition layer. */
  clearLimit: (field: GoalLimitField) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type GoalDefaultsRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createGoalDefaultsRowStore>>
  & PropsLocale<'goal'> & GoalDefaultsRowInjected

/** The editable fields in display order, with their copy. */
const FIELDS = [
  { field: 'defaultMaxGoalRounds', label: 'defaults.rounds.label', hint: 'defaults.rounds.hint' },
  { field: 'maxGoalTokens', label: 'defaults.tokens.label', hint: 'defaults.tokens.hint' },
  { field: 'maxGoalWorkMs', label: 'defaults.work.label', hint: 'defaults.work.hint' },
] as const satisfies readonly { field: GoalLimitField; label: GoalKey; hint: GoalKey }[]

/**
 * Read one draft as a positive safe integer.
 * @param text - the field's current draft.
 * @returns the accepted value, or undefined while the draft is not one.
 */
function parseLimit(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Render the goal-limits row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function GoalDefaultsRow({ t, useStore, setLimit, clearLimit }: GoalDefaultsRowComponentProps) {
  const rounds = useStore(s => s.rounds)
  const tokens = useStore(s => s.tokens)
  const workMs = useStore(s => s.workMs)
  const [editing, setEditing] = useState<GoalLimitField | null>(null)
  const [draft, setDraft] = useState('')
  const resolved: Record<GoalLimitField, number | null> = {
    defaultMaxGoalRounds: rounds,
    maxGoalTokens: tokens,
    maxGoalWorkMs: workMs,
  }
  const draftRejected = editing !== null && draft.trim().length > 0 && parseLimit(draft) === undefined
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('defaults.title')}</div>
        <div className={css.desc}>{draftRejected ? t('defaults.invalid') : t('defaults.description')}</div>
      </div>
      <div className={css.fields}>
        {FIELDS.map((entry) => {
          const current = resolved[entry.field]
          const focused = editing === entry.field
          const rejected = focused && draft.trim().length > 0 && parseLimit(draft) === undefined
          return (
            <div key={entry.field} className={css.field}>
              <label className={css.label} htmlFor={entry.field}>{t(entry.label)}</label>
              <input
                id={entry.field}
                className={rejected ? css.inputInvalid : css.input}
                type="text"
                inputMode="numeric"
                {...rejected ? { 'aria-invalid': true } : {}}
                value={focused ? draft : current === null ? '' : String(current)}
                onChange={(event) => {
                  setDraft(event.target.value)
                  const parsed = parseLimit(event.target.value)
                  if (parsed !== undefined) setLimit(entry.field, parsed)
                }}
                onFocus={() => {
                  setEditing(entry.field)
                  setDraft(current === null ? '' : String(current))
                }}
                onBlur={() => {
                  setEditing(null)
                  if (draft.trim().length === 0 && current !== null) clearLimit(entry.field)
                }}
              />
              <p className={css.hint}>{t(entry.hint)}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
