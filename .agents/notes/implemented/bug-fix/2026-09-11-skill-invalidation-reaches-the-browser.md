# Agent Note: A skill catalog change reaches the browser without a reload

Status: implemented

English | [中文](2026-09-11-skill-invalidation-reaches-the-browser.zh.md)

## Problem

The browser half of the `/` menu caches `skills/list` per session. The skill registry invalidation that should have dropped those caches never left the Host. `skills/change` was declared and dispatched inside `packages/skill/skill/src/index.ts`, the package's Host entry, and the package published no client-safe type face — so `packages/api/remotes` could not read the declaration at all. Adding the name to the forwarded-event allowlist failed its `satisfies readonly TypertForwardableEventEntry[]` assertion, because an event the face cannot see is not a forwardable event.

The user-visible result: disabling a plugin in the marketplace panel parked its skill entries, the Host catalog dropped them immediately, and the `/` menu kept offering every one of them until the page was reloaded. The model and the menu disagreed about what the deployment had, and only one of them was right.

## Decision

The registry's unfiltered invalidation is forwarded to the browser, and the client treats it as a cache-wide drop.

**The owner package supplies the declaration.** `packages/skill/skill/src/types.ts` is a new client-safe face exported as `./types`, holding the `skills/change` `Events` declaration. `src/index.ts` re-exports that face with `export type *`, which is what carries the augmentation into the package's emitted `index.d.ts`. A type-only `import type {} from './types.ts'` reads correctly inside the source program and is elided from declaration output, so every consumer that resolves this package through a project reference — including this package's own tests inside the repo-wide Host aggregate — stops seeing the event. This is the arrangement `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-settings` and `@deepseek-ai/dsh-agent-presets` already use, and the allowlist's own contract names it: each entry's declaration lives in its owner package's client-safe `./types` export, so the two compiler faces of `packages/api/remotes` read one declaration rather than a restatement.

**Forwarding is a truthful claim about the carrier, not a per-feature choice.** The event is unscoped and returns `void`, so it is exactly what `emit` forwarding preserves; `{ event: 'skills/change', mode: 'emit' }` joins the allowlist.

**The client clears every cached session.** The event carries no payload by design — invalidation is unfiltered, because a provider registration, a disposal, a marketplace enable or disable, and a filesystem watcher all reach it. Ownership of a materialized skill entry is not a function of the plugin name (a duplicate-name conflict resolves by state order), so the set of affected sessions is not computable on the client. `ui-skill` therefore clears all keys on `skills/change`, keeps dropping exactly one key on `agent-preset/selected`, and keeps clearing everything on `connection/reset`.

## Alternatives considered

**Declaring `skills/change` a second time inside `packages/api/remotes`, beside the allowlist.** Rejected: the allowlist deliberately asserts against the owner's declaration so a signature change breaks the build of the package that forwards it. A local copy would satisfy the assertion while allowing the Host's real signature and the forwarded one to drift apart silently.

**Forwarding a marketplace-specific signal instead of the registry event.** Rejected: the panel is one producer among several. A marketplace signal would leave the filesystem watcher and runtime provider churn still needing a reload, and the client would need two invalidation paths where the registry already has one.

**Reusing the forwarded `commands/change`.** Rejected: skills are not commands. `dsh-tool-skill` registers nothing in the commands registry, so a skill catalog can change while the command directory is untouched — the earlier assumption that one covered the other is what left this gap.

**Clearing only the sessions whose catalogs the panel could have affected.** Rejected: the panel knows the plugin, not the sessions; and a shared discovery root means one plugin's entries can collide with another's by name.

## Consequences

- `skills/change` rides the Remote event stream; the generated event matrix records `packages/skill/skill/src/types.ts` as its home and `remotes` as a listener.
- `@deepseek-ai/dsh-skill` gains a public `./types` subpath export; `packages/api/remotes` and `packages/client/ui-skill` gain it as a development dependency, and `tsconfig.base.json` gains its source alias.
- The `/` menu now reflects enablement immediately: an open panel toggle or a watcher-driven change costs the next menu open one `skills/list` per session, with no reload.
- An in-flight catalog fetch is aborted by the invalidation. That path already existed for preset switches; it now runs for every catalog mutation.

## Testing

`packages/api/remotes/tests/remote-events.host.spec.ts` asserts the frames a client stream receives, including the payload-free `skills/change`, so the allowlist entry is pinned by what crosses the wire rather than by the constant alone. `packages/client/ui-skill/tests/browser-plugin.client.spec.ts` asserts the cache effect: a forwarded `skills/change` costs both cached sessions one refetch each, where `agent-preset/selected` costs only the recomposed session. The client assertion was confirmed to fail with the listener removed.

The declaration's reach is only proved by the repo-wide aggregates. Per-package `tsc -b` passes with the elided type-only import, because that program reads the source file; `tsc -b tsconfig.host.json` compiles the consumers that resolve the package through its declaration output, and it is the check that caught this.
