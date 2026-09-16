# Handoff — DSH 獨立 repo：plugin marketplace + web 面板（2026-09-11）

接手對象：下一個 session／另一台機器。本文假設你**沒有**本次對話的上下文。

---

## 1. 這是什麼專案、東西在哪

| 項目 | 值 |
|---|---|
| 本機工作區 | `D:\deepseek-harness` |
| **主 repo（已獨立）** | `https://github.com/ivankwanpn/deepseek-harness`（remote 名 **`origin`**） |
| 上游（只讀保留） | `https://github.com/deepseek-ai/deepseek-harness`（remote 名 **`upstream`**） |
| 本次分支 | `feat/plugin-marketplace` |
| feature commit | `feat(marketplace): add a plugin marketplace, its CLI, and a read-only web panel`（44 檔、+5050 / −1） |
| handoff commit | `docs: handoff for the marketplace work and the fork takeover` |
| 是否仍是 fork？ | **不是。** 2026-09-11 已 `Leave fork network`，GitHub API 回報 `fork: false`、無 parent |

**remote 佈局（2026-09-11 起）**：

```
origin    https://github.com/ivankwanpn/deepseek-harness   ← 你的 repo，主要推送目標
upstream  https://github.com/deepseek-ai/deepseek-harness  ← 只讀保留，方便日後手動 fetch 參考
```

`upstream` **只讀**，不要推它。它的存在只是讓我們哪天想參考上游演進、或改變主意想回頭貢獻時路還在；不需要就 `git remote remove upstream`。

**已無法用 `gh pr create` 送 PR 回上游** —— 這是脫離 fork network 的必然代價（不可逆）。若日後要貢獻，只能 `git format-patch` 手動處理。

## 2. 交接前請先知道的三件事

**（1）這些檔案原本只存在於 `feat/plugin-marketplace` 分支。** 兩個 commit（`feat(marketplace): add a plugin marketplace, its CLI, and a read-only web panel` 功能 + `docs: handoff for the marketplace work and the fork takeover` handoff）都在該分支上；後續的 marketplace 修補已經併入 `master`。

**（1b）分支基底比當時的 `master` 舊 134 個 commit。** 這是預期且已知的狀態：

- `feat/plugin-marketplace` 從建立 fork 當時的 `master` 分出。
- 當時的 `master` 已經到了上游 `release(dsh): 0.1.5-rc.2` 的同步合併。
- **`master` 上那 134 個 commit 完整保留**（脫離 fork network 沒有丟掉任何東西）。
- 所以：功能可用、與 `master` 的差異只在 marketplace 這 44 個檔案，但**基底較舊**。若你要拿最新的 0.1.5-rc.2 當基底，需要把這個分支 rebase 到 `master`（我沒有做，因為那要 force-push 且可能有衝突——未經確認不該動已推送的歷史）。

**（2）建置順序有硬依賴。** 前端套件的 tsdown 需要先有 `tsc` 產出的 `lib/types/`，否則會 `UNRESOLVED_ENTRY: Cannot resolve entry module lib/types/index.js`：

```
npx tsc -b tsconfig.host.json      # host 產物
npx tsc -b tsconfig.client.json    # client 產物（順序不能顛倒）
npx tsdown --env.DSH_BUILD_FACE host
npx tsdown --env.DSH_BUILD_FACE client
```

或直接 `pnpm run build`（約 3–5 分鐘，會一併建置前端）。

**（3）跑 GUI 之前一定要先建置。** `dsh web` 從已建置的 `lib/` 載入外掛；原始碼改了但沒建置，瀏覽器會顯示 **"Failed to load plugins"**。這是本次踩過最大的坑。

## 3. 我做了什麼（功能面）

一個 plugin marketplace，加一個**唯讀**的 web 面板。

- **CLI**：`dsh plugin --profile web marketplace <add|list|search|install|uninstall|installed|enable|disable>`
  - 注意 `--profile` 是 `plugin` 子命令的**必填選項**，所以要寫成 `dsh plugin --profile web marketplace list`，不是 `dsh --profile web plugin marketplace`。
- **主機端**：`MarketplaceGateway`（Typert remote，namespace `marketplace`，方法 `status`）。讀 state 檔與 patch 層，**不落地、不寫檔、不快取**。
- **前端**：`@deepseek-ai/dsh-client-ui-settings-marketplace`，掛在 Settings → Plugins 底下的一個新分頁。

**設計上的兩個關鍵決定**（改動前請先讀懂，否則很容易改壞）：

1. **列 id 不是外掛名稱的函式。** MCP 列以**淨化後的伺服器名稱**為鍵（`marketplace:mcp:<serverName>`），而一個外掛可以宣告多個伺服器。所以列 id 在**安裝時**就被記錄進 state（`entry.rowIds`），`enable`/`disable`/`installed` 讀回它。**若你看到有人把它改回 `marketplace:<plugin>` 的重算寫法，那是迴歸**——它會匹配不到任何列、什麼都沒寫，卻回報成功。有測試釘住這件事。
2. **讀取絕不落地。** `materializeEntry` 會複製 skills、甚至把 skills 搬到 `.disabled`，那是**寫入**。gateway 因此改從 `.mcp.json` 推導列 id。有一個測試用整棵目錄樹的快照比對來釘住「讀取不改變磁碟」，把它換成 `materializeEntry` 會讓 3 個測試轉紅。
3. **skill 的落地佈局必須是平鋪的，而且擁有關係要記錄。** 發現根目錄是平的：`skill-filesystem` 只讀 `<root>/<name>/SKILL.md` 或 `<root>/<name>.md`，**不遞迴**，所以外掛的每個 skill 都直接落在根目錄下，名稱記進 state（`entry.skillIds`），`enable`/`disable`/`uninstall` 只針對這些名稱。**若你看到有人把落地改回 `<root>/<plugin>/…` 的巢狀寫法，那是迴歸**——`install` 會回報成功、state 會記錄 `skills`、面板會顯示已安裝，而模型一個 skill 都拿不到；卸載也會留下孤兒。決策、備選方案與測試見 Agent Note：[2026-09-11-marketplace-skills-land-flat.md](.agents/notes/implemented/bug-fix/2026-09-11-marketplace-skills-land-flat.md)。

## 4. 驗證基線（這些是已實跑過的，不是聲稱）

| 命令 | 結果 |
|---|---|
| `pnpm run build` | exit 0 |
| `npx tsc -b tsconfig.host.json` | exit 0 |
| `npx tsc -b tsconfig.client.json` | exit 0 |
| `npx oxlint packages` | **0 errors / 0 warnings** |
| `npx vitest run packages/host/plugin-marketplace` | 28 passed（marketplace 10 + gateway 7 + skills 11） |
| 16 個 `verify-*` 閘門 | PASS |

閘門清單：`verify-export-jsdoc`、`verify-package-invariants`、`verify-package-readme-{summaries,model-experience,limitations}`、`verify-dsh-package-licenses`、`verify-package-paths`、`verify-config-source-ownership`、`verify-translation-pairing`、`verify-tsconfig-paths`、`verify-package-dependencies`、`verify-runtime-closure`、`verify-vendored-links`、`verify-md-wrap`、`verify-md-links`、`verify-client-catalog`。

**兩個紅的閘門，同一個根源：`verify-cordis-config` 與 `verify-node-next-types`** —— 都與 marketplace 變更無關，成因是這台機器**建立不了符號連結**（行程非管理員、未開 Windows 開發人員模式；`fs.symlinkSync(..., 'dir')` 實測回 `EPERM`，而 junction 不受影響）。

- `verify-cordis-config`：這個 checkout 的 `core.symlinks=false`，使 `apps/cli/tests/profiles/acp/cordis.yml` 等 **11 個 git mode `120000` 的符號連結**被實體化成內容為目標路徑的純文字檔（`.agents/notes/implemented/CLAUDE.md` 的內容就是 `AGENTS.md` 一行字），閘門讀到字串而非 Loader 陣列。
- `verify-node-next-types`：該閘門用 `fs.symlinkSync` 建一個臨時消費者專案，在連結階段就 `EPERM`，因此**只印「typecheck failed」而沒有任何 tsc 錯誤訊息**——看到這種空錯誤就是它，不是型別問題。

**判斷法**：hygiene 的紅燈只要沒有具體的 `error TS` 或檔案路徑，就是這兩個環境問題。開啟 Windows 開發人員模式（再以 `core.symlinks=true` 重新 checkout 那 11 個檔案），或以管理員權限執行該閘門，即消失；CI 跑在 Linux 上不受影響。

## 5. 這台機器／這個 checkout 的環境事實

- **`DSH_HOME` 已被設為 `C:\Users\IvanKwan\.dsh`**（harness 環境自己設的，不是我設的）。所以「真實」patch 層在 `~/.dsh/cordis.patch.yml`，目前**不存在**。
- **profile 的 patch 層在 `~/.dsh/profiles/web/cordis.patch.yml`**。`apps/cli/src/profile-boot.ts` **同時監看兩者**，所以寫 home 層也會生效（且是 HMR 即時生效、不用重啟）。
- **`~/.agents/skills` 有 14 個項目**（superpowers）。任何會寫這裡的測試都必須隔離。
- **`core.symlinks=false`**（見上）。
- git 身分**只設在這個 repo**：`ivankwanpn` / `213307026+ivankwanpn@users.noreply.github.com`。全域未設。
- 本次所有破壞性測試都用 `DSH_HOME` + `DSH_AGENTS_HOME` 指向 `$env:TEMP` 隔離。

## 6. 踩過的坑（請務必讀，這些都真的發生過）

1. **`zod` 必須是 `dependencies`，不能只放 `peerDependencies`。** typert 產生的 `lib/typert.remote-client.js` / `typert.host.js` 在 runtime 會 `import ... from 'zod'`。漏了它，`dsh web` 會整個掛掉並顯示 `Failed to load plugins ... resolver("zod") missed the module table`，而且**同一個 server 上的其他 client plugin 也一起死**。已修（`plugin-marketplace/package.json`）。
2. **`tsdown` 的進入點清單是 `lib/types/{index,invariant,startup}.js`。** 宣告在 `exports` 裡的**其他**子路徑不會被 bundle。`./marketplace-command` 因此必須指向 `lib/types/marketplace-command.js`（tsc 產物），不能指向 `lib/marketplace-command.js`。同層的 `plugin-inventory` 的 `./typert`、`./remote` 是**既存的同類問題**（指向不存在的檔案），我沒動。
3. **不要從 Node-only 套件 import 到會被瀏覽器編譯面讀到的模組。** gateway 原本從 `@deepseek-ai/dsh-app-boot` import `PROFILE_PATCH_FILENAME`，導致 client 編譯把整個 Node 套件（`node:fs`、`node:url`）拉進瀏覽器目標。現改用字面值 `'cordis.patch.yml'`。同理，`gateway.ts` **刻意不再匯出** `./types.ts`（那會讓 Remote 宣告指向 gateway，重蹈覆轍）。
4. **`oxlint` 不在 `verify-*` 閘門裡。** 「閘門全綠」不代表 lint 過。我當時跑了 16 個閘門都綠，卻有 17 個 lint 錯誤，是 pre-commit hook 才擋下來。**送 PR 前請跑 `npx oxlint packages`。**
5. **PowerShell 的 `Set-Content -Encoding UTF8` 會加 BOM。** 用它寫 commit message 會讓 subject 開頭帶 `\uFEFF`。用 `[System.IO.File]::WriteAllBytes` 或 `git commit -m`。另外別用 PowerShell 管線取值再寫檔（會把換行壓成單行）。
6. **`src/` 曾被建置產物污染兩次**（`types.js`、`*.d.ts` 等，`lib/` 有被 `.gitignore` 擋、`src/` 沒有）。提交前請 `git status --porcelain --untracked-files=all` 逐一確認，不要只看 `git status --short`。

## 7. 殘留 / 未做

- **web 面板是唯讀的。** 安裝／解除安裝／啟用／停用仍只在 CLI。要在瀏覽器做需要一套權限與確認機制（這是我刻意的範圍切分，不是遺漏）。
- **`commands/` 能力偵測得到但掛不上。** 已查證根因：Claude 的指令是一個 Markdown 提示詞（`## Your Task` …），「呼叫它」等於把該文字送給模型；而 DSH 的 `CommandDefinition.handler` 明文寫著「對接收的 agent 執行，**不把指令送給模型**」，`CommandInvocation` 沒有任何通往模型的路徑。這是**格式缺口，不是接線缺口**——要支援得先讓核心具備「提示展開式指令」。
- **52 個官方 registry 條目仍無法安裝。** 它們以相對路徑指名內容且無一帶 `sha`；`--allow-unpinned` 會把 ref 解析成當下的 commit 並記錄，但那是快照、不是重現性保證。
- **`scripts/dsh-net-probe.mjs`** 已包含在此 commit，它是 Node 網路診斷工具（區分 DNS/TCP/TLS/proxy），與 marketplace 無關。若想讓 commit 單一主題，可拆出去。
- **`verify-cordis-config` 與 `verify-node-next-types`** 紅燈（見 §4），同一個環境根源，與 marketplace 無關。

## 8. 建議的下一步順序

1. 在**新機器**上 `pnpm install` → `pnpm run build`，確認 `npx oxlint packages` 與 `npx vitest run packages/host/plugin-marketplace` 都乾淨。
2. 起 `dsh web`，開 Settings → Plugins → **Marketplace**，確認面板會渲染（空狀態也要正常顯示，不該是錯誤畫面）。
3. 決定要不要把 `feat/plugin-marketplace` rebase 到 `master`（見 §2 第 1b 點）。
4. 若要做第二階段（可寫入的 web 面板），先設計權限與確認流程，再動手。

## 9. 這次「脫離 fork network」的完整經過（給接手的人除錯用）

如果你之後又要做類似的事，這幾個症狀都是**正常的中間狀態**，不要誤判成失敗（我第一次就誤判了）：

| 階段 | GitHub API | 能做什麼 |
|---|---|---|
| 剛按下 Leave fork network | `fork: true`、**Settings 顯示 `Detach is in progress.`** | 什麼都不能做，**等**。重試無用 |
| 進行中嘗試 push | **HTTP 403 `Your repository is disabled`** | 這是「暫時不可用」，不是真的被停權 |
| 完成後 | `fork: false`、`parent` 消失、`disabled: false`、網頁 HTTP 200 | 正常推送 |

**我犯的錯**：只查 API 看到 `fork: true` 就告訴使用者「detach 沒生效、可能是你沒按完」——當時它其實正在跑。**判斷非同步操作的狀態時，要一併看它自己的進度指示（Settings 頁的 `Detach is in progress.`），不能只看最終欄位。**

另外一個真實的坑：**detach 後 `push master` 可能被拒（`Updates were rejected because the remote contains work that you do not have locally`）**。這不是 detach 出錯——是 fork 建立時遠端就已經比本機新（本例差 134 個 commit）。**此時正確做法是 `git fetch` 然後 `git merge --ff-only origin/master`，絕不要 force push**，否則會親手刪掉上游那些 commit。
