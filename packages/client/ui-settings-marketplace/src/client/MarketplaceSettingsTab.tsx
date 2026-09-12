/**
 * The marketplace tab: what is registered, what is installed, how each plugin
 * stands, and the controls that change it.
 *
 * Every control is a REQUEST, not a decision. The Host re-reads its own state
 * and re-checks its own permission on each call, and each write returns the
 * status it produced — so the panel renders post-write truth rather than the
 * state it hoped for, and a deployment that refuses writes shows that refusal
 * instead of a control that would silently do nothing.
 *
 * Uninstall is gated behind an explicit acknowledgement because it deletes
 * files. The toggle is not: it moves content between the discovery root and its
 * parked directory, so it is reversible without a re-fetch.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type {
  InstalledPluginView,
  MarketplaceStatusView,
  PluginEnablementView,
  PluginRemovalView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { Button, RiskConfirmation, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketplaceLocaleKey } from './locales.ts'
import css from './MarketplaceSettingsTab.module.css'

/** Registration-side Remote face used by the section. */
export interface MarketplaceSettingsTabInjected {
  /** Read the current marketplace status snapshot. */
  status: () => Promise<MarketplaceStatusView>
  /** Enable or disable one installed plugin, returning the status that write produced. */
  setEnabled: (plugin: string, enabled: boolean) => Promise<PluginEnablementView>
  /** Uninstall one installed plugin, returning the status that write produced. */
  uninstall: (plugin: string) => Promise<PluginRemovalView>
}

/** Full component props assembled by the Settings slot renderer. */
export type MarketplaceSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.marketplace'>
  & InjectFace<MarketplaceSettingsTabInjected>

type Translate = MarketplaceSettingsTabProps['t']

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly view: MarketplaceStatusView }

/**
 * Tone per install state.
 *
 * `no-rows` is deliberately NOT the error tone: a skills-only plugin is working
 * exactly as intended, and colouring it like a fault would train the user to
 * ignore the colour that does mean one.
 */
const STATE_TONE: Record<InstalledPluginView['state'], TagTone> = {
  enabled: 'success',
  disabled: 'neutral',
  'no-rows': 'info',
  'not-mounted': 'warning',
}

/** Locale key for one install state's short label. */
const STATE_LABEL: Record<InstalledPluginView['state'], MarketplaceLocaleKey> = {
  enabled: 'stateEnabled',
  disabled: 'stateDisabled',
  'no-rows': 'stateNoRows',
  'not-mounted': 'stateNotMounted',
}

/** Locale key for the sentence explaining one install state. */
const STATE_DETAIL: Record<InstalledPluginView['state'], MarketplaceLocaleKey> = {
  enabled: 'stateEnabledDetail',
  disabled: 'stateDisabledDetail',
  'no-rows': 'stateNoRowsDetail',
  'not-mounted': 'stateNotMountedDetail',
}

/** Locale key for one skills placement. */
const SKILLS_LABEL: Record<InstalledPluginView['skills'], MarketplaceLocaleKey> = {
  live: 'skillsLive',
  parked: 'skillsParked',
  none: 'skillsNone',
}

/**
 * Whether one plugin can be toggled, and which way it currently stands.
 *
 * A plugin is ON when every mechanism it has is on: its loader rows (none means
 * nothing to mount, not "off") and its skills (none means it ships none). A
 * plugin with neither has no toggle at all, which is why the panel hides the
 * control instead of rendering a switch that cannot move.
 *
 * @param entry - the installed plugin view.
 * @returns whether a toggle applies, and the state it should show.
 */
function toggleOf(entry: InstalledPluginView): { canToggle: boolean; isOn: boolean } {
  const rowsOn = entry.rowIds.length === 0 || entry.state === 'enabled'
  const skillsOn = entry.skills === 'none' || entry.skills === 'live'
  return {
    canToggle: entry.rowIds.length > 0 || entry.skills !== 'none',
    isOn: rowsOn && skillsOn,
  }
}

/** One installed plugin: its facts, and the controls that act on it. */
function InstalledCard({ entry, t, editable, busy, failed, onToggle, onUninstall }: {
  entry: InstalledPluginView
  t: Translate
  editable: boolean
  busy: boolean
  failed: string | undefined
  onToggle: (plugin: string, enabled: boolean) => void
  onUninstall: (plugin: string) => void
}): ReactNode {
  const toggle = toggleOf(entry)
  return (
    <li className={css.card}>
      <div className={css.cardHead}>
        <span className={css.cardTitle}>{entry.plugin}</span>
        <Tag tone={STATE_TONE[entry.state]}>{t(STATE_LABEL[entry.state])}</Tag>
      </div>
      <dl className={css.facts}>
        <dt>{t('pinLabel')}</dt>
        <dd className={css.mono}>{entry.sha ?? t('noPin')}</dd>
        <dt>{t('capabilitiesLabel')}</dt>
        <dd>{entry.capabilities.length > 0 ? entry.capabilities.join(', ') : t('noCapabilities')}</dd>
        <dt>{t('rowsLabel')}</dt>
        <dd className={css.mono}>
          {entry.rowIds.length > 0 ? entry.rowIds.join(', ') : '—'}
        </dd>
        <dt>{t('skillsLabel')}</dt>
        <dd>{t(SKILLS_LABEL[entry.skills])}</dd>
        <dt>{t('contentLabel')}</dt>
        <dd className={css.mono}>{entry.installPath}</dd>
      </dl>
      <p className={css.detail}>{t(STATE_DETAIL[entry.state])}</p>
      <p className={css.provenance}>{entry.marketplace}</p>
      {editable
        ? (
          <div className={css.controls}>
            {toggle.canToggle
              ? (
                <Switch
                  checked={toggle.isOn}
                  disabled={busy}
                  label={`${entry.plugin} — ${t('toggleLabel')}`}
                  title={busy ? t('toggleLocked') : undefined}
                  onChange={(next) => { onToggle(entry.plugin, next) }}
                />
              )
              : null}
            <Button variant="outline" disabled={busy} onClick={() => { onUninstall(entry.plugin) }}>
              {t('uninstall')}
            </Button>
            {busy ? <span className={css.muted}>{t('working')}</span> : null}
          </div>
        )
        : null}
      {failed !== undefined ? <p className={css.actionError}>{`${t('actionFailed')}${failed}`}</p> : null}
    </li>
  )
}

/** The marketplace panel content. */
export function MarketplaceSettingsTab({
  status,
  setEnabled,
  uninstall,
  t,
}: MarketplaceSettingsTabProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [acknowledged, setAcknowledged] = useState(false)
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({})

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' })
    try {
      setState({ status: 'ready', view: await status() })
    } catch {
      // The specific failure is the Host's to describe and the panel has no
      // use for a transport code; offering a retry is the actionable part.
      setState({ status: 'error' })
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  /** Run one write, then render the status it returned. */
  const write = useCallback(async (
    plugin: string,
    run: () => Promise<MarketplaceStatusView>,
  ): Promise<void> => {
    setBusy(plugin)
    setFailures(current => ({ ...current, [plugin]: '' }))
    try {
      setState({ status: 'ready', view: await run() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setFailures(current => ({ ...current, [plugin]: message }))
    } finally {
      setBusy(undefined)
    }
  }, [])

  if (state.status === 'loading') return <p className={css.muted}>{t('loading')}</p>
  if (state.status === 'error') {
    return (
      <div className={css.errorBox}>
        <p>{t('error')}</p>
        <button type="button" className={css.retry} onClick={() => void load()}>
          {t('retry')}
        </button>
      </div>
    )
  }

  const { marketplaces, installed, allowMutations } = state.view
  return (
    <div className={css.root}>
      {allowMutations ? null : <p className={css.readOnly}>{t('readOnly')}</p>}

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('marketplacesTitle')}</h3>
        {marketplaces.length === 0
          ? <p className={css.muted}>{t('marketplacesEmpty')}</p>
          : (
            <ul className={css.list}>
              {marketplaces.map(market => (
                <li key={market.name} className={css.card}>
                  <div className={css.cardHead}>
                    <span className={css.cardTitle}>{market.name}</span>
                  </div>
                  <p className={css.mono}>{market.url}</p>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('installedTitle')}</h3>
        {installed.length === 0
          ? <p className={css.muted}>{t('installedEmpty')}</p>
          : (
            <ul className={css.list}>
              {installed.map(entry => (
                <InstalledCard
                  key={`${entry.marketplace}/${entry.plugin}`}
                  entry={entry}
                  t={t}
                  editable={allowMutations}
                  busy={busy === entry.plugin}
                  failed={failures[entry.plugin] === '' ? undefined : failures[entry.plugin]}
                  onToggle={(plugin, next) => {
                    void write(plugin, async () => (await setEnabled(plugin, next)).status)
                  }}
                  onUninstall={(plugin) => {
                    setAcknowledged(false)
                    setConfirming(plugin)
                  }}
                />
              ))}
            </ul>
          )}
      </section>

      <RiskConfirmation
        open={confirming !== undefined}
        title={confirming === undefined ? t('uninstallTitle') : `${t('uninstallTitle')} · ${confirming}`}
        description={t('uninstallDescription')}
        acknowledgeLabel={t('uninstallAcknowledge')}
        cancelLabel={t('uninstallCancel')}
        closeLabel={t('uninstallCancel')}
        confirmLabel={t('uninstallConfirm')}
        acknowledged={acknowledged}
        disabled={busy !== undefined}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => {
          setAcknowledged(false)
          setConfirming(undefined)
        }}
        onConfirm={() => {
          const plugin = confirming
          setAcknowledged(false)
          setConfirming(undefined)
          if (plugin === undefined) return
          void write(plugin, async () => (await uninstall(plugin)).status)
        }}
      />
    </div>
  )
}
