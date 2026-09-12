# Agent Note: 「有没有 pwsh」指的是 pwsh，不是 Windows PowerShell 5.1 后备项

Status: implemented

[English](2026-09-12-pwsh-probe-accepts-the-51-fallback.md) | 中文

## 问题

`resolvePwshPath` 会回传显式 `pwshPath`、Windows PowerShell 7 的已知安装位置、PATH 条目，或在旧式主机上作为最后手段回传 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。有十一个呼叫点用「spawn 这次解析、读退出状态」的方式询问「有没有 pwsh」：九个测试套件、session-snapshot 测试框架，以及 `vitest.config.ts` 里的覆盖率探针。在只有 Windows PowerShell 5.1 的主机上，那个后备项是可以执行的，所以它们全都回答了「有」。

覆盖率探针自己的注释就写明了这次被破坏的约定：豁免存在的目的，是让测试跳过的那些主机保持绿灯，而「一个不一致、更窄的探针，可能会在测试其实会运行的主机上豁免该文件」。这里的不一致是反方向的——**一个更宽的探针在该主机上让豁免没有生效**，而测试于是失败而不是跳过。两种形态：一个案例把裸名 `pwsh` 交给 ACL runner 时出现 `CreateProcessAsUserW failed (Win32 2)`；另一个案例断言被包起来的是哪个 shell 时出现 `expected '…WindowsPowerShell\v1.0\powershell.exe' to match /pwsh(\.exe)?$/`。

## 决定

`src/resolve.ts` 导出 `isPwsh(resolved)`，作为「这个可执行文件是 pwsh」的唯一一份定义：它最后一段路径名是 `pwsh` 或 `pwsh.exe`。判断会同时切两种分隔符，因为解析是针对运行平台作答，而纯函数的测试也会从任何主机上询问 Windows 路径。

覆盖率豁免所绑在一起的那三个位置——`vitest.config.ts`、`pwsh-local/tests/executor.spec.ts`、`pwsh-sandbox/tests/sandbox.spec.ts`——现在除了退出状态为零之外，还要求 `isPwsh(resolved)`，因此豁免与测试在结构上必然得到同一个答案。

`sandbox-windows-acl/tests/runner.spec.ts` 改为探测裸名 `pwsh`，因为那正是它的案例交给 runner 的东西。解析出来的路径会满足探针，却让 runner 根本 spawn 不到。

## 考虑过的替代方案

**从 `resolvePwshPath` 移除 Windows PowerShell 5.1 后备项。** 否决：正是它让 harness 能在旧式主机上运行命令，而且包的 README 记录了后备项为此固定 UTF-8 输出。

**放宽 pwsh-sandbox 的断言，接受任何 PowerShell。** 否决：那个套件存在的意义就是测试 pwsh 沙箱，而那条断言正是它表明这一点的方式。在没有 pwsh 的主机上，跳过才是诚实的结局。

**让 `runner.spec.ts` 把解析后的路径交给 runner。** 否决：那会让 ACL 案例在 Windows PowerShell 5.1 上运行——那是没有任何 CI runner 演练过的 shell——凭的是无人验证过的假设。

## 后果

- 只有 Windows PowerShell 5.1 的主机现在会跳过它跑不了的套件，而不是让它们失败：在回报的那台主机上是两个包共七个失败。
- 覆盖率豁免恰好在那些套件跳过时生效，这正是它自己注释所要求的。`packages/sandbox/sandbox-windows-acl` 在端对端套件跳过后仍逐档 100%，因为该包另外十个套件覆盖了同一批原始码。
- `isPwsh` 从 `dsh-pwsh-local` 导出。其余八个可用性探针保留各自的副本且未改动：它们把关的套件并不声称自己被包起来的是哪个 shell，所以后备项对它们今天不构成假失败。

## 测试

`pwsh-local/tests/executor.spec.ts` 对 `isPwsh` 覆盖了裸名、POSIX 路径、两种大小写的 Windows pwsh 路径，以及 5.1 后备项路径。ACL 包的覆盖率是在 `runner.spec.ts` 跳过的状态下量测的，以确认这次跳过没有留下无人覆盖的原始码。
