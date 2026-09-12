# Agent Note: A namespace service's own names no longer reserve Remote method names

Status: implemented

English | [中文](2026-09-12-remote-method-names-outlive-their-installer.zh.md)

## Problem

The Client Remote service published each mounted method as an accessor on the namespace service object, and that same object carried the machinery that installs methods — including a private `install()`. Publishing a method named `install` therefore hit the collision guard: `'install' in this` was true because the service had its own `install`, so the mount was refused and the namespace never appeared.

Because `@deepseek-ai/dsh-api-remotes` mounts every selected contribution as one assembly, that single refusal failed the whole browser boot. The panel rendered `Failed to load plugins` and no settings page loaded at all; the failing entry was the assembly, not the marketplace namespace.

The reserved set was invisible. It consisted of whatever the installing class happened to be built out of — `install`, `installDirect`, `installScoped`, `remove`, `has`, `empty` — so a method name could be refused for a reason its author could not see in any type, and the refusal named a collision the caller had no way to avoid short of renaming.

## Decision

The method records move into a `RemoteMethodTable` that the namespace service holds. The service's published surface is now `methods`, `invokeRemote`, `installDirect`, and `installScoped`; the names it reserves are those, `REMOTE_NAMESPACE_FIELDS`, and its class prototype.

`install`, `remove`, and `has` — the installing machinery's own former names — became publishable. A namespace may now mount a method with any of them, and the accessor is withdrawn again when its last variant is disposed.

The table owns the records and the accessors, and reads the service lazily, because the service hands the table over before it finishes constructing itself. `RemoteNamespaceService.assertMethodAvailable` keeps its static form and remains the one place the reserved set is stated.

## Alternatives considered

**Renaming the marketplace method to something the guard accepts.** Rejected: the wire name is a contract the panel and the CLI already speak, and the next package to publish `remove` or `has` would hit the same wall. The defect is that the reserved set was arbitrary, and renaming one caller leaves it arbitrary.

**Denying the installing machinery's names explicitly.** Rejected: that is a denylist maintained against a class's private members, so it goes stale the moment a helper is renamed or added — and it would keep refusing names that are only ever reached through the table.

**Defining the accessors on a separate published object instead of the service.** Rejected: the accessors read the caller Context through the service's own `ctx`, and plugin code reaches them by asking Cordis for the namespace service. Moving the accessors would change how every consumer reaches a Remote method.

## Consequences

- A Remote method name no longer depends on what the installing machinery is called, in either direction: machinery names do not reserve published ones, and a published name cannot shadow the machinery.
- `RemoteNamespaceService`'s surface changed for in-process readers: `has`, `remove`, and `empty` are gone in favour of `methods.isMounted`, `methods.withdraw`, and `methods.isEmpty`. Every consumer was inside `api/gateway`.
- `methods`, `invokeRemote`, `installDirect`, and `installScoped` remain reserved and are now asserted as such by test, so a future helper added to the service is a deliberate reservation rather than an accident.
- The browser boot path has coverage it did not have. The unit suites could not see this defect: `gateway.client.spec.ts` tests collisions on names it chooses, so it never chose the one the shipped assemblies use, and the marketplace package's own suites never mount the client assembly at all.

## Testing

`packages/api/remotes/tests/assembly.client.spec.ts` mounts the real selected contribution set through the real gateway and asserts `marketplace.install` is callable, which is the path a browser takes at boot. `packages/api/gateway/tests/gateway.client.spec.ts` keeps its collision cases on names the service still reserves (`installDirect`, `methods`) and adds a loop that mounts, calls, and disposes a namespace method named `install`, `remove`, and `has`, asserting the accessor exists while mounted and is gone after disposal. `DSH_SNAPSHOT=replay pnpm run test:web:built` runs the assembled browser over the replayed scenarios.
