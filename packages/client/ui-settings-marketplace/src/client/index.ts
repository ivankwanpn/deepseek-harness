/**
 * Marketplace status and its enable/uninstall controls, registered into Web
 * Settings.
 *
 * The Remote wrappers live here rather than in the component so the panel deals
 * in values and thrown errors: unwrapping the result envelope is registration
 * plumbing, and a refusal has to become a thrown error for the panel's
 * per-plugin failure state to be reachable.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `marketplace/*` Remote declarations this plugin calls.
// Without it the namespace would not exist on `ctx.remote`.
import type {} from '@deepseek-ai/dsh-host-plugin-marketplace/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  MarketplaceStatusView,
  PluginEnablementView,
  PluginRemovalView,
} from '@deepseek-ai/dsh-host-plugin-marketplace/types'
import { MarketplaceSettingsTab, type MarketplaceSettingsTabInjected } from './MarketplaceSettingsTab.tsx'
import { en, zh, type MarketplaceLocaleKey } from './locales.ts'

export type { MarketplaceSettingsTabInjected, MarketplaceSettingsTabProps } from './MarketplaceSettingsTab.tsx'
export type { MarketplaceLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Marketplace copy. */
    'settings.marketplace': MarketplaceLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.marketplace'

/** Services required by the Settings registration and the generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.marketplace']

/**
 * Unwrap one Remote result, turning a refusal into a thrown error.
 *
 * The message is wire data from the Host, shown verbatim: it names the seam's
 * own refusal code, which is more useful than a translated sentence that would
 * have to guess which refusal it was.
 *
 * @param call - the Remote invocation to settle.
 * @returns the value the Host returned.
 * @throws {Error} when the Host refused the call.
 */
async function unwrap<T>(call: () => Promise<RemoteResult<T>>): Promise<T> {
  const result = await call()
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/**
 * Contribute the lazy marketplace tab to the Plugins settings section.
 *
 * @param ctx - the browser-side Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-marketplace: dictionaries')

  const t = ctx.locale.bind(NS)
  const status = (): Promise<MarketplaceStatusView> => unwrap(() => ctx.remote.marketplace.status())
  const setEnabled = (plugin: string, enabled: boolean): Promise<PluginEnablementView> =>
    unwrap(() => ctx.remote.marketplace.setEnabled({ plugin, enabled }))
  const uninstall = (plugin: string): Promise<PluginRemovalView> =>
    unwrap(() => ctx.remote.marketplace.uninstall({ plugin }))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'marketplace',
    // After the inventory tab (order 10), which is the read-everything view.
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (): MarketplaceSettingsTabInjected => ({ status, setEnabled, uninstall }),
  }, MarketplaceSettingsTab))
}
