/**
 * The catalog read: what the registered marketplaces offer right now.
 *
 * One operation serves both faces. The CLI prints these rows and the Web panel
 * renders them, so the traversal, the installability verdict, and the
 * containment rule exist once rather than once per caller.
 *
 * A registration that cannot be read is reported rather than thrown. The loop
 * this replaced awaited every marketplace in turn and let the first failure
 * abort the command, so one unreachable registration hid every result from the
 * ones that answered.
 *
 * This deliberately does NOT share its traversal with `resolveEntry`, which
 * resolves one name and stops at the first marketplace listing it. A catalog
 * must visit every registration, and merging the two would make every install
 * pay for the read path's completeness.
 *
 * @module @deepseek-ai/dsh-host-plugin-marketplace/catalog
 */

import { fetchMarketplace, type FetchOptions } from './fetch.ts'
import { isPinned, type MarketplaceEntry } from './parse.ts'
import { findInstalled, rowIdFor, type MarketplaceState } from './state.ts'

/** One installable entry, as a list row. */
export interface CatalogRow {
  /** Plugin name as its marketplace declares it. */
  plugin: string
  /** Marketplace this entry came from. */
  marketplace: string
  /** One-line summary the marketplace published. */
  description?: string
  /** Category the marketplace filed it under. */
  category?: string
  /** Version the marketplace declared, not the pin. */
  version?: string
  /** Free-form tags the marketplace published. */
  tags: string[]
  /** Whether our own pin rule accepts the source. Decided here, never by a caller. */
  installable: boolean
  /** Whether an installed record already exists for this name. */
  installed: boolean
  /** Diagnostics the entry carried, including a missing pin. */
  warnings: string[]
}

/** One registration that could not be read. */
export interface MarketplaceFailure {
  /** Marketplace that failed, by its registration name. */
  marketplace: string
  /** Why it failed, as the fetch layer reported it. */
  reason: string
}

/** What one catalog read produced. */
export interface CatalogResult {
  /** Every entry from every readable registration, in registration order. */
  rows: CatalogRow[]
  /** Registrations that could not be read. Their entries are simply absent. */
  failed: MarketplaceFailure[]
}

/**
 * Read every registered marketplace and normalize its entries into rows.
 *
 * @param state - the registered marketplaces, read in stored order.
 * @param options - fetch budget and cancellation passed to every read.
 * @returns the rows and the registrations that could not be read.
 */
export async function catalog(
  state: MarketplaceState,
  options: { fetch?: FetchOptions } = {},
): Promise<CatalogResult> {
  const rows: CatalogRow[] = []
  const failed: MarketplaceFailure[] = []

  for (const registration of state.marketplaces) {
    let entries: readonly MarketplaceEntry[]
    let marketplace: string
    try {
      const market = await fetchMarketplace(registration.url, options.fetch ?? {})
      entries = market.plugins
      marketplace = market.name
    } catch (error) {
      failed.push({
        marketplace: registration.name,
        /* v8 ignore next -- fetchMarketplace throws only Error instances; the String arm only satisfies the unknown narrowing. */
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    for (const entry of entries) {
      rows.push({
        plugin: entry.name,
        marketplace,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.category !== undefined ? { category: entry.category } : {}),
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        tags: [...entry.tags],
        installable: isPinned(entry),
        installed: findInstalled(state, rowIdFor(entry.name)) !== undefined,
        warnings: [...entry.warnings],
      })
    }
  }

  return { rows, failed }
}
