# Agent Note: "Is pwsh available" means pwsh, not the Windows PowerShell 5.1 fallback

Status: implemented

English | [中文](2026-09-12-pwsh-probe-accepts-the-51-fallback.zh.md)

## Problem

`resolvePwshPath` answers with an explicit `pwshPath`, a well-known Windows PowerShell 7 install, a PATH entry, or — as a last resort on a legacy host — `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. Eleven call sites asked "is pwsh available" by spawning that resolution and reading the exit status: nine suites, the session-snapshot harness, and the coverage probe in `vitest.config.ts`. On a host with only Windows PowerShell 5.1 the fallback is runnable, so every one of them answered yes.

The coverage probe's own comment states the contract this broke: the exemption exists so hosts where the suites skip stay green, and "a mismatched narrower probe could exempt the file on hosts whose suites actually run". Here the mismatch ran the other way — a looser probe kept the exemption OFF on a host where the suites cannot run, and they failed instead of skipping. Two shapes: `CreateProcessAsUserW failed (Win32 2)` where a case hands the ACL runner the bare name `pwsh`, and `expected '…WindowsPowerShell\v1.0\powershell.exe' to match /pwsh(\.exe)?$/` where a case asserts which shell was wrapped.

## Decision

`src/resolve.ts` exports `isPwsh(resolved)`, the one definition of "this executable is pwsh": its final path segment is `pwsh` or `pwsh.exe`. Both separators split it, because resolution answers for the running platform while the pure suites also ask about Windows paths from any host.

The three sites the coverage exemption ties together — `vitest.config.ts`, `pwsh-local/tests/executor.spec.ts` and `pwsh-sandbox/tests/sandbox.spec.ts` — now require `isPwsh(resolved)` as well as a zero exit status, so the exemption and the suites reach the same answer by construction.

`sandbox-windows-acl/tests/runner.spec.ts` probes the bare name `pwsh` instead, because that is what its cases hand the runner. A resolved path would satisfy the probe and then not be spawnable by the runner at all.

## Alternatives considered

**Removing the Windows PowerShell 5.1 fallback from `resolvePwshPath`.** Rejected: it is what lets the harness run commands on a legacy host, and the package README documents that the fallback pins UTF-8 output for exactly that case.

**Relaxing the pwsh-sandbox assertion to accept any PowerShell.** Rejected: the suite exists to test the pwsh sandbox, and that assertion is how it says so. Skipping is the honest outcome where no pwsh exists.

**Having `runner.spec.ts` pass the resolved path to the runner.** Rejected: it would run the ACL cases against Windows PowerShell 5.1 — a shell no CI runner exercises — on the strength of an assumption about it that nothing verifies.

## Consequences

- A host with only Windows PowerShell 5.1 now skips the suites it cannot run instead of failing them: seven failures across the two packages on the reporting host.
- The coverage exemption is active exactly when those suites skip, which is what its own comment required. `packages/sandbox/sandbox-windows-acl` still measures 100% per file with its end-to-end suite skipped, because the other ten suites in that package cover the same sources.
- `isPwsh` is exported from `dsh-pwsh-local`. The other eight availability probes keep their own copies and are unchanged: they gate suites whose cases do not assert which shell was wrapped, so the fallback is not a false failure for them today.

## Testing

`pwsh-local/tests/executor.spec.ts` covers `isPwsh` over a bare name, a POSIX path, a Windows pwsh path in either case, and the 5.1 fallback path. The ACL package's coverage was measured with `runner.spec.ts` skipped to confirm the skip leaves no uncovered source.
