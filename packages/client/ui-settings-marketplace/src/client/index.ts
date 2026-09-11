/** Read-only marketplace status registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `marketplace/status` Remote declaration this plugin
// calls. Without it the namespace would not exist on `ctx.remote`.
import type {} from '@deepseek-ai/dsh-host-plugin-marketplace/remote'
import type { MarketplaceStatusView } from '@deepseek-ai/dsh-host-plugin-marketplace/types'
import { MarketplaceSettingsTab, type MarketplaceSettingsTabInjected } from './MarketplaceSettingsTab.tsx'
import { en, zh, type MarketplaceLocaleKey } from './locales.ts'

export type { MarketplaceSettingsTabInjected, MarketplaceSettingsTabProps } from './MarketplaceSettingsTab.tsx'
export type { MarketplaceLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only marketplace copy. */
    'settings.marketplace': MarketplaceLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.marketplace'

/** Services required by the Settings registration and the generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.marketplace']

/**
 * Contribute the lazy marketplace tab to the Plugins settings section.
 *
 * The read is wrapped here rather than in the component so the panel deals in
 * the snapshot alone: unwrapping the Remote result envelope is registration
 * plumbing, and a failure has to become a thrown error for the panel's retry
 * state to be reachable.
 *
 * @param ctx - the browser-side Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-marketplace: dictionaries')

  const t = ctx.locale.bind(NS)
  const status: MarketplaceSettingsTabInjected['status'] = async (): Promise<MarketplaceStatusView> => {
    const result = await ctx.remote.marketplace.status()
    if (!result.ok) {
      throw new Error(`marketplace.status failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'marketplace',
    // After the inventory tab (order 10), which is the read-everything view.
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (): MarketplaceSettingsTabInjected => ({ status }),
  }, MarketplaceSettingsTab))
}
