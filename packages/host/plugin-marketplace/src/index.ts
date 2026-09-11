/**
 * Install and enable marketplace plugins.
 *
 * The Claude plugin marketplace format is a de-facto standard, so reading it
 * inherits an existing ecosystem instead of inventing a registry. This package
 * is the translation layer: it parses that format, fetches a plugin at its
 * pinned revision, and reconciles the result into the two surfaces DSH already
 * has, WITHOUT teaching the core anything about the external schema.
 *
 *     marketplace manifest  ──parse──▶  entries (source + pinned sha)
 *                                          │
 *                                    fetch │ (git, argv-only)
 *                                          ▼
 *                                   plugin content
 *                                          │
 *                          ┌───────────────┴───────────────┐
 *                          ▼                               ▼
 *                 skills/ file tree               .mcp.json servers
 *                          │                               │
 *              materialize into the                  one loader row each
 *              discovery root                        (`dsh-mcp-client`)
 *                          │                               │
 *                          └──────────► sync ◄─────────────┘
 *                                          │
 *                                          ▼
 *                          user patch layer (watched, live)
 *
 * Two mechanisms, one verb: {@link setEnabled} toggles a loader row's `disabled`
 * flag, and skills — which have no row — are moved out of the discovery tree.
 *
 * @module @deepseek-ai/dsh-host-plugin-marketplace
 */
export {
  MarketplaceParseError,
  isPinned,
  parseEntry,
  parseMarketplace,
  parseSource,
  type Marketplace,
  type MarketplaceEntry,
  type PluginSource,
} from './parse.ts'

export {
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_MANIFEST_BYTES,
  MarketplaceFetchError,
  candidateManifestUrls,
  fetchMarketplace,
  fetchMarketplaceFrom,
  looksLikeManifestUrl,
  marketplaceRepoRoot,
  resolveLocalSource,
  type FetchOptions,
} from './fetch.ts'

export {
  PluginFetchError,
  detectCapabilities,
  fetchPlugin,
  resolveRefSha,
  type FetchPluginResult,
} from './git.ts'

export {
  MARKETPLACE_STATE_VERSION,
  MarketplaceStateError,
  defaultStatePath,
  emptyState,
  findInstalled,
  loadState,
  removeInstalled,
  rowIdFor,
  saveState,
  upsertInstalled,
  upsertMarketplace,
  type InstalledCapability,
  type InstalledEntry,
  type MarketplaceState,
} from './state.ts'

export {
  PatchLayerError,
  composePatchLayer,
  parsePatchLayer,
  presentIds,
  readEnabled,
  serializePatchLayer,
  setEnabled,
  writePatchLayerIfChanged,
  type ManagedRow,
  type ParsedPatchLayer,
} from './patch-layer.ts'

export {
  DISABLED_SKILLS_DIRNAME,
  MCP_CLIENT_MODULE,
  defaultAgentsSkillsDir,
  disabledSkillsDir,
  materializeEntry,
  materializeSkills,
  normalizeMcpServers,
  readPluginMcp,
  sanitizeServerName,
  setSkillsEnabled,
  skillsDirFor,
  skillsEnabled,
  type MaterializeOptions,
  type MaterializeResult,
  type NormalizedMcpServer,
} from './materialize.ts'

export { sync, type SyncOptions, type SyncResult } from './sync.ts'

export {
  InstallError,
  addMarketplace,
  installPlugin,
  pluginInstallPath,
  resolveEntry,
  uninstallPlugin,
  type InstallOptions,
  type InstallResult,
} from './install.ts'
