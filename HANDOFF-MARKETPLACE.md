# Handoff — DSH fork: plugin marketplace + web panel (2026-09-11)

接手對象：下一個 session／另一台機器。本文假設你**沒有**本次對話的上下文。

---

## 1. 這是什麼專案、東西在哪

| 項目 | 值 |
|---|---|
| 本機工作區 | `D:\deepseek-harness` |
| 你的 fork | `https://github.com/ivankwanpn/deepseek-harness` |
| 上游 | `https://github.com/deepseek-ai/deepseek-harness`（remote 名 `origin`） |
| 本次分支 | `feat/plugin-marketplace` |
| 本次 commit | `de1f0309ef`（44 檔、+5050 / −1） |
| 已推上 fork？ | 是。**尚未開 PR 回上游**（`gh pr list` 為空，是刻意的，等你裁定） |

`origin` 仍指向官方 repo、`fork` 指向你的 fork。要開 PR：

```
gh pr create --repo deepseek-ai/deepseek-harness --base master --head ivankwanpn:feat/plugin-marketplace
```

## 2. 交接前請先知道的三件事

**（1）這是一個新套件，但它是「未追蹤 → 已提交」的狀態。** 上游 `master` 完全沒有這些檔案；所有東西都在 `feat/plugin-marketplace` 這一個 commit 裡。

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

## 4. 驗證基線（這些是已實跑過的，不是聲稱）

| 命令 | 結果 |
|---|---|
| `pnpm run build` | exit 0 |
| `npx tsc -b tsconfig.host.json` | exit 0 |
| `npx tsc -b tsconfig.client.json` | exit 0 |
| `npx oxlint packages` | **0 errors / 0 warnings** |
| `npx vitest run packages/host/plugin-marketplace` | 17 passed（marketplace 10 + gateway 7） |
| 16 個 `verify-*` 閘門 | PASS |

閘門清單：`verify-export-jsdoc`、`verify-package-invariants`、`verify-package-readme-{summaries,model-experience,limitations}`、`verify-dsh-package-licenses`、`verify-package-paths`、`verify-config-source-ownership`、`verify-translation-pairing`、`verify-tsconfig-paths`、`verify-package-dependencies`、`verify-runtime-closure`、`verify-vendored-links`、`verify-md-wrap`、`verify-md-links`、`verify-client-catalog`。

**唯一紅的閘門：`verify-cordis-config`** —— 與本次變更無關。成因：這個 checkout 的 `core.symlinks=false`，使 `apps/cli/tests/profiles/acp/cordis.yml` 等 **11 個 git mode `120000` 的符號連結**被實體化成內容為目標路徑的純文字檔，閘門讀到字串而非 Loader 陣列。**無管理員權限無法修**（建立符號連結需要該權限或開啟開發者模式）。換到 Linux/macOS 或以管理員權限重新 checkout 即消失。

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
- **`verify-cordis-config`** 紅燈（見 §4）。

## 8. 建議的下一步順序

1. 在**新機器**上 `pnpm install` → `pnpm run build`，確認 `npx oxlint packages` 與 `npx vitest run packages/host/plugin-marketplace` 都乾淨。
2. 起 `dsh web`，開 Settings → Plugins → **Marketplace**，確認面板會渲染（空狀態也要正常顯示，不該是錯誤畫面）。
3. 決定要不要開 PR 回上游。
4. 若要做第二階段（可寫入的 web 面板），先設計權限與確認流程，再動手。
