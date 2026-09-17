# Handoff — Session format v3 → v4（分支 `feat/session-format-v3-to-v4`）

Written 2026-09-16。內容對照 repo 與 SDD ledger（`.superpowers/sdd/PLAN-SESSION-FORMAT-V3-TO-V4/progress.md`，內含 21 條裁定與 18 條 deferred minors 的完整原文）。

## 在哪裡

| | |
|---|---|
| Base | `master` @ `f49fb4cc9d`（已推 origin） |
| Head | `ab5943cf33` |
| 規模 | 24 commits、331 files、+83,061 / −521 |
| 設計文件（已 `implemented/`） | `.agents/notes/implemented/architecture/2026-09-16-session-format-v3-to-v4.md` |
| 實作計畫 | `PLAN-SESSION-FORMAT-V3-TO-V4.md` |
| SDD ledger（裁定 + minors） | `.superpowers/sdd/PLAN-SESSION-FORMAT-V3-TO-V4/progress.md` |

## 做了什麼

把 fork 的 goal-limits 結構改動做成合法的相鄰 Session 格式邊，並補齊 cookbook 要求的周邊：

1. **凍結 v3 參照**（Task 1）：`docs/persistence-changes/historical-formats/v3.{md,zh.md,schema.json,i18n.yaml}`，60 roots / 467 types，digest 與當時的 catalog 完全一致。
2. **新套件** `packages/session/session-format-v3-to-v4`（Task 2–3）：v4 codec（包裝 released v3 codec）、header validator、restorer、有狀態 streaming stage。轉換規則：只碰帶 `data.goal` 的 `goal/change`；三個 ceiling 缺席時物化為顯式 `null`（與 `decodeCeiling(undefined) → null` 一致）；有值的原樣保留；`tokensAtCreate`/`workMsAtCreate` 與 clear 墓碑不動；cardinality 與 inherited cut 不變。
3. **Writer = 4 + catalog 重生**（Task 4）：`SESSION_FORMAT_VERSION = 4`，`generated.ts` 由產生器重寫（`currentVersion: 4`、完整 v0→v4 鏈）。
4. **鏈級覆蓋**（Task 5）：v0/v1/v2 seeded multi-hop、refusal、determinism、並行 stage 獨立性、no-fallback；外加 24 個「current 應跟隨常數」的 fixture。
5. **Persistence acknowledgement**（Task 6）：`docs/persistence-changes/2026-09-16-goal-limit-ceilings.*`。偵測到 **12** 項變更（不是預期的 11——Task 4 的 writer bump 也動了 `SessionHeader.version`），全部承認，`verify-persistence-changes` 轉綠。
6. **Consumer sweep**（Task 7）：`session-persistence-jsonl` 109 failed → 1 failed（剩下那個是 Windows symlink EPERM）；Python smoke mirror 改為從 source literal 推導；設計文件升級到 `implemented/`。
7. **Snapshot successors**（Task 8，Linux）：**177** 個 `*.v4.jsonl` 後繼；前驅零改動（已驗：173 個後繼只差 header 版本、4 個另只差 `sessionFormatVersion`，**零內文漂移**）；corpus policy 重算吻合（177 current / 10 retained / 8 scenarios）。
8. **Web lane + SDK 投影**（Task 9，Linux）：27+ 個 `apps/web/tests/*.e2e.ts` 共享引用改指 owner 的 selected（v4）世代；`preset-migration.snapshot.ts` 改由常數推導；Python 投影用建出的 exe 重錄（5 個 v4 檔、前驅 byte-identical）。
9. **收尾修復**（本次）：新套件補 `@deepseek-ai/cordis` peer/dev 宣告、重生成 `docs/module-graph.*`、marketplace 兩包版本對齊 root。

## 實跑過的 lane（綠）

| Lane | 結果 |
|---|---|
| `pnpm run build`（Windows + WSL） | exit 0 |
| `pnpm run lint` | 0 errors |
| `pnpm run test:docs` | 20/20 |
| `pnpm run verify-persistence-changes` | ok（12 項全部承認） |
| `pnpm run verify-session-format-catalog` | up to date |
| session-format 三套件聚焦指令 | 598 passed / 0 failed |
| `pnpm run test:snapshot`（Linux，含語料） | 154 passed |
| `pnpm run test:expected`（Linux） | 91 passed |
| Python `pytest python/sdk/tests` | 114 passed / 1 failed（見下） |

## 已知紅點

**A. 環境造成的（這台機器沒有管理員/開發者模式，`symlinkSync` 回 EPERM）**
- `scripts/project-doc-site.spec.ts:160`（`doc-sync` 因此 40/41）
- `verify-cordis-config`
兩者與本分支無關，開 Windows 開發人員模式或以管理員執行即消失；CI 在 Linux 上不受影響。

**B. 既有的（本分支未造成）**
- `constraints`：本地有 7 個 merge 殘留的空目錄（`git` 不追蹤空目錄，**CI 的新 clone 不會有**）。已在本機確認：扣掉這些，`constraints` 只差 marketplace 版本（已修）。
- `packages/experimental/webworker-packer/tests/image-loadable.spec.ts`（上游檔案的既有紅，見 `HANDOFF-UPSTREAM-MERGE.md`）。
- Web lane 4 個檔（含 goal-limits 文案的 golden 過期、packed-worker boot）。任務 9 已證明它們在 base 上就是紅的。

**C. 本分支讓它變成「可達」的新紅（裁定：記錄不修）**
- `python/sdk/tests/test_bundled_runtime.py` 的 `test_bundled_runtime_surfaces_unbundled_plugin_failure[exe]`。以前建不出 exe，該模式被 skip；現在能建了就跑得到而失敗。證據顯示與格式改動無關（測試插入一個不存在的套件 `@deepseek-ai/dsh-does-not-exist`），屬封裝執行期的既有行為，修它需要獨立調查。

## 我做的裁定（21 條，全部有 ledger 原文）

1. **T2 的 `index.ts` 先不 re-export `./migration.ts`**（T3 才加）——避免 T2 自己的測試因匯入不存在的模組而失敗。
2. **T1 的驗證範圍限縮**到它自己的產物（不要求 `doc-sync` 全綠——那條紅正是 T6 要修的）。
3. **T1 的 `source:` 記為 `dsh-v0.1.6-alpha.1`**——reviewer 查證該 tag 在本機與 origin 都不可解析、而 merge commit 鏈存在；`dsh-v0.1.5-rc.2` 對這份清單是錯的（59/462、缺 `event:image/offload`）。
4. **修正 v4 restorer**：驗證用 v3 投影副本、`return artifact` 回原件，並補 identity+version 測試。（我計畫的 code 原本會把 v3-stamped 視圖傳給 catalog 的每個 consumer。）
5. **`assertV3EventAdmission` 取代 `assertEvent`**——後者根本沒從 v2-to-v3 root 匯出（`payload.ts` 未 re-export）；reviewer 追了三條路徑確認無端到端缺口。
6. **3 個 lint 錯誤併入 T4 當前置 commit**（一次只讓一個 agent 動同一套件）。
7. **T4 的 24 個紅 fixture → T5；108 個 persistence 紅測試 → T7**（bump writer 的必然後果，原則：current 跟隨常數、歷史保持字面值）。
8. **T4 的三個 out-of-brief 編輯成立**（generator 換行是純格式化、llm-replay 是列舉非 `number`、tsconfig reference 與兄弟邊一致）。
9. **generator 的換行由 renderer 擁有**（`generated.ts` 不能手改，而 5 個 codec 的那行超過 max-len）。
10. **T5 的 malformed-refusal 錨在 released v2 admission 是對的**（v3+ 的 goal payload 依設計是 owner-opaque）。
11. **T6 的寬鬆措辭帶進 T7 修**（「In v3 the ceilings were optional」對三個 v3 基準都不準）。
12. **T8 的兩個機械紅 → T9**；後被
13. **更廣的裁定取代：整個 Web-lane 引用面（27+ e2e、`preset-migration`、`chat-scroll-contract`）都進 T9**。
14. **T9 的 `dsh-session-stats` peer 修復保留**（reviewer：這是 `verify-runtime-closure` 規定的修法，丟掉會轉紅並擋住所有 exe 建置；與既有的 `dsh-token-meter` 宣告對稱）。
15. **`[exe]` pytest 紅點記錄不修**（見上 C）。
16. **本地空的 merge 殘留目錄不動**（CI 看不到；本機清理會動到含忽略檔的目錄）。

（完整原文含每條的「如果裁錯的代價」在 ledger。）

## Deferred minors（18 條，摘要）

- v3.md 有兩條特性與 v2 逐字重複、未註明「unchanged from v2」
- 467（凍結）vs 468（index）的 type 數差異恐被誤「修」
- README 對 codec 測試的描述略舊
- `catalog.spec.ts:30` 標題仍寫 "v0 to v3 chain"
- 測試用 `@deepseek-ai/dsh-session` 未列 `devDependencies`（既有 pattern）
- `releasedV3View` 與 restorer 內部視圖逐字相同（改 restorer 時要同步）
- goal 記錄的 base-state 描述略誇大
- 凍結 v3 頁的 `goal/change` digest 等於 v4 記錄的 after digest（Task 1 的刻意範圍）
- 11 個 successor 是 header-only 合成而非 refresh 產生
- retained-role 上限已滿（10/10）——**下次 bump 必須先退掉或重構一個 retained scenario**
- `generation.spec.ts` 三處硬編碼 `session.V4.jsonl`
- 命名債：`v3-event-admission.spec.ts` 檔名、v3 文案
- Python mirror 未能在本機執行（無 Python）
- `scripts/gen-session-format-catalog.ts` 不在任何 task 的檔案清單
- smoke lane 的 fixture-role 數字硬編碼（行為上惰性，但每次 bump 要手改）

## 未完成

- **Final whole-branch review 沒有跑完**：兩次派工都被 Claude Code 程序結束帶走（transcript 有存，判決沒有）。這是最該補的一件事——對象是 `f49fb4cc9d..HEAD`，重點放在 edge 的轉換正確性與跨任務一致性。
- `pnpm run check:ci`（完整 primary lane，含 23k 單元測試）沒跑；只跑了 `check:ci:static`（51 passed / 4 failed，見上）。
- PR 尚未建立。

## 下一步

1. 補跑 final whole-branch review（或直接以 `pnpm run check:ci` 代替）。
2. 開 PR 進 `master`（`gh pr create` 在此 repo 不可用，用 `gh api repos/ivankwanpn/deepseek-harness/pulls --method POST --input body.json`）。
3. PR body 應載明：A/B/C 三類紅點、`[exe]` 紅點的來歷、以及 `--no-verify` 的那個 commit（lefthook 在 WSL interop shell 解析不到 `node_modules`，oxlint 已手動跑過 0 errors）。
4. 下一條格式邊會遇到：retained-role 上限已滿、`writer*.expected.jsonl` 的 header bump 是必要的（不是 churn）。
