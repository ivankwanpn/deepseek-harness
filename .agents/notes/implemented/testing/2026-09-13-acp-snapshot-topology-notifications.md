# Agent Note: Deterministic ACP snapshots for best-effort topology notifications

Status: implemented

English | [中文](2026-09-13-acp-snapshot-topology-notifications.zh.md)

## Problem

ACP resolves model options outside its ordered output chain. Discovery that finishes before close begins can enqueue a `config_option_update` notification; discovery that finishes later discards it. Exact stdout snapshots therefore depend on scheduling even when every prompt result and persisted Session event agrees. The [standard ACP controls](../feature/2026-08-22-standard-acp-automation-controls.md) remain supported independently of this snapshot policy.

## Decision

The [ACP suite](../../../../packages/test-support/session-snapshot/src/suite.ts) applies the same projection to actual and committed stdout: remove a frame only when it is a JSON-RPC 2.0 notification with no `id`, method `session/update`, and `params.update.sessionUpdate` equal to `config_option_update`. Parsing inspects protocol fields, never substrings in user or tool text. Other frames retain their bytes after the existing stdout normalization; configuration responses, correlated requests, transcript updates, and persisted Session comparisons retain their assertions. Invalid JSON still fails.

For a stable frame sequence S and any insertion of these notifications, the projection returns S. Notification count, position, discovery latency, and the outcome of its race with close cannot affect the projected comparison. This establishes determinism for this source of variation, without claiming that unrelated lane failures are impossible. Record and refresh write the projected stdout; replay projects committed fixtures in memory without rewriting them.

## Alternatives considered

**Await discovery during close.** A provider may never resolve model discovery. Waiting would violate the existing guarantee that prompt completion and close remain responsive.

**Publish discovery results after close begins.** Removing the closing check permits late notifications after teardown and still leaves their presence dependent on process shutdown timing.

**Require the notification in every fixture.** The product does not promise delivery before close. Recording either scheduling outcome turns an optional notification into an unsupported assertion.

**Suppress redundant topology notifications in the product.** Revision tracking changes observable behavior and does not settle genuine topology changes during a session. Snapshot comparison only needs to respect the existing delivery guarantee.

## Consequences

These snapshots intentionally do not detect missing or malformed option payloads inside matching topology notifications. The [ACP bridge tests](../../../../packages/acp/acp/tests/bridge.spec.ts) own catalog contents, publication after topology changes, and hung-discovery prompt/close behavior. The [suite tests](../../../../packages/test-support/session-snapshot/tests/suite.spec.ts) prove projection invariance for absent, repeated, and repositioned notifications, retention of other protocol frames and embedded text, and rejection of invalid JSON. Product lifecycle behavior remains unchanged.
