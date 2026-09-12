/**
 * Wire contract for the marketplace Remote face.
 *
 * Deliberately SEPARATE from `state.ts`, which is the on-disk schema. The state
 * file is this package's private record and may gain fields freely; the Remote
 * face is a published contract that a browser bundle compiles against, so
 * widening it is a compatibility decision rather than a local edit. The two are
 * mapped explicitly in the gateway, where a change to either is visible.
 *
 * The active state vocabulary is COMPUTED, not stored: enablement lives in the
 * patch layer and is read back per request, so a browser render can never show
 * a stale "enabled" for a plugin the user disabled from the CLI.
 *
 * @module @deepseek-ai/dsh-host-plugin-marketplace/types
 */

/** One registered marketplace, as the panel lists it. */
export interface MarketplaceRegistrationView {
  /** Marketplace name the manifest declares; the registration's identity. */
  name: string
  /** Manifest url this registration resolves to. */
  url: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * This deployment serves the marketplace Remote face read-only.
     *
     * Its own code rather than `gateway/bad-request`: the request was well
     * formed, and the panel tells the user the deployment refused, not that
     * their click was malformed.
     */
    'marketplace/read-only': {}
    /** The named plugin has no installed record, so there is nothing to toggle or remove. */
    'marketplace/not-installed': { readonly plugin: string }
  }
}

/**
 * How one installed plugin stands right now.
 *
 * `no-rows` is a real, expected outcome rather than an error: a plugin whose
 * only capability is skills mounts no loader row, because skills are discovered
 * from the filesystem. Reporting it as `disabled` would be wrong.
 */
export type InstalledStateView = 'enabled' | 'disabled' | 'no-rows' | 'not-mounted'

/**
 * Where one plugin's skills currently are.
 *
 * Skills mount by DISCOVERY rather than by a loader row, so their enablement
 * never appears in the patch layer: it is whether the entries the plugin owns
 * sit in the discovery root or parked beside it. `none` means the plugin ships
 * no discoverable skill, which is a different fact from a parked one.
 */
export type SkillsStateView = 'live' | 'parked' | 'none'

/** One installed plugin, joined across the state file and the patch layer. */
export interface InstalledPluginView {
  /** Plugin name as its marketplace declares it. */
  plugin: string
  /** Marketplace this came from. */
  marketplace: string
  /** Pinned commit, absent for a source that carries no revision. */
  sha?: string
  /** Directory the content was materialized to. */
  installPath: string
  /** Capabilities detected on disk after fetching. */
  capabilities: string[]
  /** Patch rows this plugin owns; empty when it mounts no loader row. */
  rowIds: string[]
  /** Discovery-root entries this plugin owns; empty when it ships no skill. */
  skillIds: string[]
  /** Enablement and mount status, read from the patch layer now. */
  state: InstalledStateView
  /** Where the owned skill entries are right now. */
  skills: SkillsStateView
}

/**
 * Everything the marketplace panel renders from one read.
 *
 * Returned as a single snapshot rather than several calls so the two halves
 * cannot disagree: a panel that read marketplaces and plugins separately could
 * render an install whose marketplace is not listed.
 */
export interface MarketplaceStatusView {
  /** Registered marketplaces, in the order `resolveEntry` searches them. */
  marketplaces: MarketplaceRegistrationView[]
  /** Installed plugins, in state-file order. */
  installed: InstalledPluginView[]
  /**
   * Whether this deployment serves the write methods at all.
   *
   * Reported so the panel can explain why it offers no controls, instead of
   * rendering buttons whose every click is refused. The Host still enforces it
   * on each call; this field is display input, never the check.
   */
  allowMutations: boolean
}

/** One plugin to enable or disable. */
export interface PluginEnableRequest {
  /** Plugin name as its marketplace declares it. */
  plugin: string
  /** Desired state: true to mount and discover, false to take both away. */
  enabled: boolean
}

/** One plugin to uninstall. */
export interface PluginUninstallRequest {
  /** Plugin name as its marketplace declares it. */
  plugin: string
}

/**
 * What one enablement change did.
 *
 * Counts and flags rather than sentences: the panel owns its copy, and a Host
 * that returned rendered English would put product text outside the locale
 * dictionaries.
 */
export interface PluginEnablementView {
  /** Plugin the call addressed. */
  plugin: string
  /** Loader rows whose `disabled` flag this call rewrote. */
  rowsChanged: number
  /** True when the plugin's skills moved between discovery and parking. */
  skillsMoved: boolean
  /**
   * True when the plugin already stood in the requested state.
   *
   * Reported rather than treated as an error: the caller asked for an end state
   * that already holds, which is a success with nothing to do.
   */
  alreadyInState: boolean
  /** True when the plugin mounts nothing at all, so no toggle could apply. */
  mountsNothing: boolean
  /** The status after the write, so the panel needs no second round trip. */
  status: MarketplaceStatusView
}

/** What one uninstall removed. */
export interface PluginRemovalView {
  /** Plugin the call addressed. */
  plugin: string
  /** True when an installed record existed and was removed. */
  removed: boolean
  /** The status after the write, so the panel needs no second round trip. */
  status: MarketplaceStatusView
}
