/**
 * The available-plugins section: what the registered marketplaces offer.
 *
 * It reads on REQUEST rather than on mount. Every other read in this tab is
 * local, so the tab cannot be blanked by a network fault; loading a catalog
 * when the tab opens would make opening a settings page wait on a git fetch.
 *
 * Filtering happens here, over rows the Host already returned, so a keystroke
 * costs nothing. The predicate is character-for-character the one the CLI
 * applies on the Host: one substring test over the same four fields.
 */
import type { ReactNode } from 'react'
import type { MarketplaceCatalogView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplaceSettingsTabProps } from './MarketplaceSettingsTab.tsx'
import css from './MarketplaceSettingsTab.module.css'

/**
 * Whether one row matches a filter, by the same fields the CLI searches.
 * @param row - the catalog row to test.
 * @param query - the current filter text; blank matches everything.
 * @returns whether the row stays visible.
 */
export function matchesQuery(row: MarketplaceCatalogView['rows'][number], query: string): boolean {
  // Trimmed like the CLI's joined arguments, so a stray space cannot exclude
  // every row, and a blank filter means "no filter" rather than "no match".
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  const haystack = `${row.plugin} ${row.description ?? ''} ${row.category ?? ''} ${row.tags.join(' ')}`.toLowerCase()
  return haystack.includes(needle)
}

/** The section's props, threaded from the tab's owner site. */
export interface CatalogSectionProps {
  /** Bound translate for this plugin's namespace. */
  readonly t: MarketplaceSettingsTabProps['t']
  /** The loaded catalog, absent until the user asks for it. */
  readonly view: MarketplaceCatalogView | undefined
  /** Whether a read is in flight. */
  readonly loading: boolean
  /** Whether the last read failed. */
  readonly failed: boolean
  /** Current filter text. */
  readonly query: string
  /** Read the catalog for the first time. */
  readonly onLoad: () => void
  /** Read it again. */
  readonly onRefresh: () => void
  /** Replace the filter text. */
  readonly onQuery: (next: string) => void
}

/**
 * Render the section.
 * @param props - the section's props, threaded from the tab's owner site.
 * @returns the section, in its unloaded or loaded form.
 */
export function CatalogSection({ t, view, loading, failed, query, onLoad, onRefresh, onQuery }: CatalogSectionProps): ReactNode {
  if (view === undefined) {
    return (
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('catalogTitle')}</h3>
        <Button variant="outline" disabled={loading} onClick={onLoad}>{t('catalogLoad')}</Button>
        {loading ? <p className={css.muted}>{t('catalogLoading')}</p> : null}
        {failed ? <p className={css.actionError}>{t('catalogFailed')}</p> : null}
      </section>
    )
  }

  const rows = view.rows.filter(row => matchesQuery(row, query))
  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('catalogTitle')}</h3>
      <input
        className={css.filter}
        type="search"
        value={query}
        placeholder={t('catalogSearchPlaceholder')}
        aria-label={t('catalogSearchPlaceholder')}
        onChange={(event) => { onQuery(event.target.value) }}
      />
      <Button variant="outline" disabled={loading} onClick={onRefresh}>{t('catalogRefresh')}</Button>
      {loading ? <p className={css.muted}>{t('catalogLoading')}</p> : null}
      {failed ? <p className={css.actionError}>{t('catalogFailed')}</p> : null}
      {view.failed.map(failure => (
        <p key={failure.marketplace} className={css.actionError}>
          {`${t('catalogMarketplaceFailed')} ${failure.marketplace}: ${failure.reason}`}
        </p>
      ))}
      {rows.length === 0
        ? <p className={css.muted}>{view.rows.length === 0 ? t('catalogEmpty') : t('catalogNoMatch')}</p>
        : (
          <ul className={css.list}>
            {rows.map(row => (
              <li key={`${row.marketplace}/${row.plugin}`} className={css.card}>
                <div className={css.cardHead}>
                  <span className={css.cardTitle}>{row.plugin}</span>
                  {row.installed ? <Tag tone="info">{t('catalogInstalled')}</Tag> : null}
                  {row.installable ? null : <Tag tone="warning">{t('catalogUnpinned')}</Tag>}
                </div>
                {row.description !== undefined ? <p className={css.detail}>{row.description}</p> : null}
                {row.warnings.map(warning => <p key={warning} className={css.detail}>{warning}</p>)}
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
