/**
 * Client-safe event declaration owned by the skill registry, shared with
 * type-only consumers. Nothing here reaches a Host-only symbol, so a Client
 * compilation face reads the same `skills/change` signature the Host emits —
 * including the Remote Event allowlist, whose entries are asserted against the
 * declared Cordis event vocabulary.
 *
 * @module @deepseek-ai/dsh-skill/types
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A skill provider, runtime contribution, or provider-backed catalog may
     * have changed. This is an unfiltered invalidation notification; consumers
     * refetch the catalog for their own lookup options. Listener failures are
     * contained and cannot veto the registry mutation.
     * @mode emit
     */
    'skills/change'(): void
  }
}

export {}
