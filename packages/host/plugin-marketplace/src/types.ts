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

/**
 * How one installed plugin stands right now.
 *
 * `no-rows` is a real, expected outcome rather than an error: a plugin whose
 * only capability is skills mounts no loader row, because skills are discovered
 * from the filesystem. Reporting it as `disabled` would be wrong.
 */
export type InstalledStateView = 'enabled' | 'disabled' | 'no-rows' | 'not-mounted'

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
  /** Enablement and mount status, read from the patch layer now. */
  state: InstalledStateView
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
}
