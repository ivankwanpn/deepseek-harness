/**
 * The marketplace tab: what is registered, what is installed, and how each
 * installed plugin currently stands.
 *
 * Read-only. Every mutation (install, uninstall, enable) stays on the CLI for
 * now, so this surface has no confirmation, permission, or partial-failure
 * story to get wrong — it reports state and nothing else.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { MarketplaceStatusView, InstalledPluginView } from '@deepseek-ai/dsh-api-remotes/client'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketplaceLocaleKey } from './locales.ts'
import css from './MarketplaceSettingsTab.module.css'

/** Registration-side Remote face used by the section. */
export interface MarketplaceSettingsTabInjected {
  /** Read the current marketplace status snapshot. */
  status: () => Promise<MarketplaceStatusView>
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

/** One installed plugin, as a row of facts. */
function InstalledCard({ entry, t }: { entry: InstalledPluginView; t: Translate }): ReactNode {
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
        <dt>{t('contentLabel')}</dt>
        <dd className={css.mono}>{entry.installPath}</dd>
      </dl>
      <p className={css.detail}>{t(STATE_DETAIL[entry.state])}</p>
      <p className={css.provenance}>{entry.marketplace}</p>
    </li>
  )
}

/** The marketplace panel content. */
export function MarketplaceSettingsTab({ status, t }: MarketplaceSettingsTabProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })

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

  const { marketplaces, installed } = state.view
  return (
    <div className={css.root}>
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
                <InstalledCard key={`${entry.marketplace}/${entry.plugin}`} entry={entry} t={t} />
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}
