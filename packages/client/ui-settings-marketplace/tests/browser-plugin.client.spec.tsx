// @vitest-environment jsdom
/**
 * The marketplace plugin's registration half: the tab it contributes to Plugins
 * settings, and the Remote wrappers its inject face hands the panel.
 *
 * The wrappers live in the plugin so the panel deals in values and thrown
 * errors. A refusal has to become a thrown error, or the panel's own failure
 * state is unreachable and a refused read would render as an empty catalog.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  MarketplaceCatalogView,
  MarketplaceStatusView,
  PluginEnablementView,
  PluginRemovalView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  PluginEnableRequest,
  PluginUninstallRequest,
} from '@deepseek-ai/dsh-host-plugin-marketplace/types'
import { apply, inject, NS } from '../src/client/index.ts'
import { MarketplaceSettingsTab } from '../src/client/MarketplaceSettingsTab.tsx'
import type { MarketplaceSettingsTabInjected } from '../src/client/MarketplaceSettingsTab.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

/** One Remote result envelope, resolved or refused, as the gateway returns it. */
type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const STATUS: MarketplaceStatusView = { marketplaces: [], installed: [], allowMutations: true }
const CATALOG: MarketplaceCatalogView = { rows: [], failed: [] }
const ENABLEMENT: PluginEnablementView = {
  plugin: 'superpowers',
  rowsChanged: 1,
  skillsMoved: false,
  alreadyInState: false,
  mountsNothing: false,
  status: STATUS,
}
const REMOVAL: PluginRemovalView = { plugin: 'superpowers', removed: true, status: STATUS }
const REFUSED = { ok: false, error: { code: 'marketplace/read-only', message: 'refused' } } as const

/** A client Cordis root carrying the slots, locale and marketplace Remote the plugin injects. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const marketplace = {
    status: vi.fn<() => Promise<Result<MarketplaceStatusView>>>().mockResolvedValue({ ok: true, value: STATUS }),
    setEnabled: vi.fn<(request: PluginEnableRequest) => Promise<Result<PluginEnablementView>>>()
      .mockResolvedValue({ ok: true, value: ENABLEMENT }),
    uninstall: vi.fn<(request: PluginUninstallRequest) => Promise<Result<PluginRemovalView>>>()
      .mockResolvedValue({ ok: true, value: REMOVAL }),
    catalog: vi.fn<() => Promise<Result<MarketplaceCatalogView>>>().mockResolvedValue({ ok: true, value: CATALOG }),
  }
  ctx.provide('remote.marketplace', marketplace)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, marketplace }
}

/** Declare the Plugins tab slot the contribution registers into. */
function declareTabs(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-marketplace browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.marketplace'])
  })

  it('registers a localized tab whose inject face unwraps every marketplace call', async () => {
    const b = await bench()
    declareTabs(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(MarketplaceSettingsTab)
    expect(entry.options).toMatchObject({ id: 'marketplace', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('插件市场')
    // Registering reads nothing: the panel asks when the user does.
    expect(b.marketplace.status).not.toHaveBeenCalled()
    expect(b.marketplace.catalog).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => MarketplaceSettingsTabInjected)()
    await expect(injected.status()).resolves.toEqual(STATUS)
    await expect(injected.catalog()).resolves.toEqual(CATALOG)
    await expect(injected.setEnabled('superpowers', false)).resolves.toEqual(ENABLEMENT)
    await expect(injected.uninstall('superpowers')).resolves.toEqual(REMOVAL)
    expect(b.marketplace.setEnabled).toHaveBeenCalledWith({ plugin: 'superpowers', enabled: false })
    expect(b.marketplace.uninstall).toHaveBeenCalledWith({ plugin: 'superpowers' })

    // A refusal is thrown, not returned: the panel's failure state depends on it.
    b.marketplace.catalog.mockResolvedValueOnce(REFUSED)
    await expect(injected.catalog()).rejects.toThrow('marketplace/read-only: refused')
    b.marketplace.status.mockResolvedValueOnce(REFUSED)
    await expect(injected.status()).rejects.toThrow('marketplace/read-only: refused')

    await b.ctx.fiber.dispose()
  })

  it('follows a late tab declaration and removes its contribution when disposed', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declareTabs(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Marketplace')

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    // The dictionary effect left with the fiber: the namespace is free again.
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    stop()
    await b.ctx.fiber.dispose()
  })
})
