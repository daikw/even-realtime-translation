# Phase 2 Implementation Handoff

> このファイルは「Phase 2 audio migration の実装を別の Claude Code セッションで再開する」ためのキックオフ用ハンドオフメモなのだ。
>
> **使い方**: 新しい Claude Code セッションを `cd ~/ghq/github.com/daikw/even-realtime-translation && claude` で開いて、このファイルの中身を最初のメッセージとしてそのまま貼り付けるのだ。

---

## 役割

`docs/phase2-migration-plan.md` の Step 0〜7a を実装する。

## リポジトリ状態 (引き継ぎ時点)

- 作業 dir: `~/ghq/github.com/daikw/even-realtime-translation`
- branch: `main` (最新 commit `357907a` "docs(plan): apply 2nd Codex review")
- PR #1 (M0-M2 PoC) merge 済み
- 関連 Issue:
  - **#6 Phase 2 migration** ← あなたのトラッキング先
  - **#7 Discord 確認 (実機 getUserMedia NotAllowedError)** ← ユーザーが投稿中
  - #2 rate limit / #3 latency / #4 CSP+helmet / #5 supply-chain notes (Phase 2 とは独立)

## 必読ドキュメント (順番に)

1. `docs/phase2-migration-plan.md` — Codex 2 回レビュー反映済み (24KB)
   - §3 Task breakdown が実装単位
   - §4 dependency graph で並列順序
   - §6 rollback strategy (Step 7b 削除は §6 gate 通過後)
   - §8 acceptance criteria (4 段 checklist)
   - §10 Codex review log
2. `docs/realtime-translation-eveng2-mvp-design.md` — 原設計書、§5.2 / §14.2 が今やる経路
3. SDK 真実値:
   - `node_modules/.pnpm/@evenrealities+even_hub_sdk@0.0.10/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`
   - `node_modules/.pnpm/@evenrealities+even_hub_sdk@0.0.10/node_modules/@evenrealities/even_hub_sdk/README.md`

## 進め方 (確定済み方針 — 前セッションで決まった答え)

- T0.1 spike (実 OpenAI WS smoke) を **Claude が実行**。`.env` の `OPENAI_API_KEY` 使用、費用 minimal。
- **`swarm-dev` で並列実装**。Plan §4 dependency graph に従い:
  - Phase A (並列): T0.1 + T0.2
  - Phase B (並列): T1.1 (`packages/shared` PCM) + T1.2 (`packages/shared` WS types) + T3 (bridgeMic) — T0.2 完了後
  - Phase C: T2 (backend WS relay) — T1.2 完了後
  - Phase D: T4 (frontend WS client) — T1.1 + T1.2 + T3 完了後
  - Phase E: T5 (App glue + Vite `ws: true` + `TranslationRuntime` 抽象) — T4 完了後
  - Phase F: T7a (docs + deprecate-only) — T5 完了後
- **PR は step ごとに小さく**:
  - PR-1: T0 spike script (commit せず、結果サマリだけ Issue #6 にコメント)
  - PR-2: `feat(shared): pcm helpers and ws protocol types` (T1.1 + T1.2)
  - PR-3: `feat(backend): openai realtime translation ws relay` (T2)
  - PR-4: `feat(app): bridgeMic + websocket translation client` (T3 + T4)
  - PR-5: `feat(app): wire translation runtime + same-origin ws proxy` (T5 + T7a)
- T6 (audio output) と T7b (物理削除) は **本実装範囲外**

## 着手チェックリスト (start sequence)

```bash
# 1. リポジトリ最新化
cd ~/ghq/github.com/daikw/even-realtime-translation
git fetch && git pull origin main
git log --oneline -3  # 357907a が見えること

# 2. 環境確認
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build
# baseline: shared 61 tests / backend 50 / app 311、全 green

# 3. .env が揃ってる確認 (値は表示しない)
grep -E '^[A-Z_]+=' .env | awk -F= '{printf "%-22s %d chars\n", $1, length($2)}'
# OPENAI_API_KEY と SAFETY_ID_SALT が non-zero であること

# 4. 走っていれば一旦 kill
pkill -f '@even-rt/backend' 2>/dev/null
pkill -f 'tsx watch' 2>/dev/null
pkill -f vite 2>/dev/null

# 5. Issue #6 に着手宣言コメント
gh issue comment 6 --body "Picking up Phase 2 implementation from \`docs/phase2-migration-plan.md\` §3."
```

その後 Plan §3 を熟読し、T0.1 spike から開始。

## 制約 (`~/.claude/CLAUDE.md` 準拠)

- 質問に対しては回答のみ、実装は明示されない限り行わない (= Plan を実装するのは明示済み)
- 複雑な判断は Codex セカンドオピニオン (`/codex` skill or `codex` agent)
- 依存追加は `pnpm add --save-exact <pkg>@<version>`、`supply-chain-security.md` 厳守
- mise でツール管理: `mise use -g npm:<pkg>@<version>` のみ
- main 直接 commit は個人 PoC 例外条項あり、**ただし PR フローを優先**
- 過剰な diag ログを commit に残さない (前回 `apps/evenhub-app/src/diag.ts` のような一時 panel は実装中も最小限、必要なら `*.dev.ts` 等の suffix で除外管理)

## 既知のリスク

- **#7 Discord 回答待ち**: 「getUserMedia を opt-in で expose できる」回答が来た場合、本実装は不要になる可能性。ただし `TranslationRuntime` 抽象は rollback 容易性のため維持価値あり
- Tailscale Serve は前セッションで停止しているはず。実機検証時は `tailscale serve --bg https+insecure://localhost:5173` で再開
- `vite.config.ts` は前回 `@vitejs/plugin-basic-ssl@2.3.0` 導入済み、`hmr` を `VITE_HMR_HOST` env 経由にしている。Phase 2 では proxy の `/api` に `ws: true` を **足す** だけ
- T0.1 spike で OpenAI WS endpoint / payload が plan 想定と違ったら、**即 plan §10.3 を作って記録した上で** 実装軌道修正

## 完了報告フォーマット

各 PR を merge する前に Issue #6 にコメント:

```
## PR-X (step Tn): <タイトル>

- 追加/変更: <ファイル数> files
- テスト件数: shared <N>+<delta> / backend <N>+<delta> / app <N>+<delta>
- coverage: <pct>%
- typecheck/lint/test/build: 全 green
- 次の step: T<n+1> (waiting on <if any>)
```

T7a まで完了したら Issue #6 を close、§6 rollback gate (実機 1 ラウンド成功 + Discord #7 回答) の状況を Issue #7 で確認。

## 質問テンプレ (Plan 不明点があれば最初のターンで)

1. Plan §x.y の <該当箇所> の解釈に迷っている、こう理解しているがどうか
2. 実装過程で <ファイル/関数> の責務が plan の <ステップ> から逸脱しそう、どう吸収する?
3. T0.1 spike の結果、<具体的差分> が plan 想定とずれている、plan を改訂する権限が欲しい

質問が無ければ淡々と進める。

---

## このメモを書いた時点での状態

- 最終 commit: `357907a docs(plan): apply 2nd Codex review (HIGH 3 + MEDIUM 3)` (2026-05-11)
- 既存 PR: なし (PR #1 merge 後、phase 2 用 PR は未作成)
- 既存ブランチ: `main` のみ
- 走っている dev server: なし (引き継ぎ前に全部 kill 済み想定)
- 既存 Tailscale serve: 停止済み (`tailscale serve reset` で消す or 別 `tailscale serve --bg` で再開)
