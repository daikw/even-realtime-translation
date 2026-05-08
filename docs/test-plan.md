# Test Plan — Even G2 Realtime Translation HUD PoC

このドキュメントは設計書 §16 / §17 の方針を、現在の実装に対する実行可能なテスト計画に落とし込んだもの。
PoC の M0〜M2（Workspace, shared, backend, evenhub-app の Even bridge / realtime / hud / state レイヤ）が対象。
M3（実機 PoC）と M4（Phase 2: G2 mic / native 拡張）はユーザー実施項目として明示する。

---

## 1. 自動テスト（Unit）

各 workspace パッケージ単位で `vitest run --coverage` を実行する。

| Package | Tests | Coverage (statements / branches / functions / lines) |
| --- | ---: | --- |
| `packages/shared` | 61 | 96.87 / 90.62 / 100 / 100 |
| `services/translation-backend` | 43 | 93.10 / 84.87 / 100 / 94.96 |
| `apps/evenhub-app` | 273 | 92.61 / 83.22 / 91.66 / 95.14 |

しきい値（`vitest.config.ts` で強制）: 全カテゴリ 80% 以上。

カバー領域は以下。

### 1.1 `packages/shared`

- `formatting/lineBreak.ts` — 文字幅計算 / 行折返し / `truncate`
- `formatting/segmentBoundary.ts` — 句点・改行・最大文字数による境界検出
- `formatting/safetyIdentifier.ts` — `OpenAI-Safety-Identifier` 用 SHA-256 ハッシュ生成
- `language.ts` — 言語コード列挙 / `nextTargetLanguage` ローテーション

### 1.2 `services/translation-backend`

- `config.ts` — env validation（必須キー欠落 / port 範囲 / origin パース）
- `openai.ts` — `requestClientSecret` の成功 / 失敗 / `mapUpstreamError` の HTTP マッピング
- `server.ts` — `/health`, `POST /api/openai/realtime/translation/session` の成功 / 各種 400 / 401 / 429 / 502, `/api/events` の 204, CORS allowlist, rate limit, malformed JSON

### 1.3 `apps/evenhub-app`

- `even/` — bridge handshake（タイムアウト / SDK 不在 / mock fallback）/ HudDisplay throttle / lifecycle subscription / input subscription / EvenStorage の JSON ラッピング
- `realtime/` — Realtime event parsing / SDP 交換 / reconnect backoff / WebRTC translation client orchestration
- `hud/` — `textFitter`（24 列折返し）/ layout（status bar / elapsed フォーマッタ）/ `screens.renderForStatus` 一式 / SubtitleBuffer（throttle / 境界検出 / max chars 強制）
- `state/` — reducer の全 action / store の listener fan-out / inputHandler の G2 ボタンマッピング
- `audio/` — `acquirePhoneMic` の permission 識別 / `audioPlayer` の attach/detach
- `backend/apiClient.ts` — backend からの success / structured error / non-JSON / network error
- `app.ts` — boot / start / connected / subtitle delta / pause / stop / reconnecting / error の遷移を mock DI で網羅
- `config.ts` — `import.meta.env` からの値読み出し

---

## 2. 自動テスト（Integration）

クロスレイヤの動作保証。`tests/integration/` 配下に配置。

### 2.1 `apps/evenhub-app/tests/integration/state-and-hud.test.ts`

純粋な「reducer + store + SubtitleBuffer + screens」の統合。`vi.useFakeTimers()` で throttle を駆動する。
DOM / fetch / RTCPeerConnection / Even bridge は使わない。

検証する観点:

- ステータス遷移ごとに `renderForStatus` が正しい画面を返す（startup → connecting → live → paused → reconnecting → exiting）
- `LANGUAGE_CHANGED` で connecting 画面の言語表記が切り替わる（AUTO→JA → EN→JA）
- `SubtitleBuffer.append('Hello, ')` → 150ms throttle 経過 → `SUBTITLE_UPDATED` dispatch → live 画面に文が反映
- `reconnecting` 中の `SUBTITLE_UPDATED` は reducer によって弾かれる
- `TICK` で `elapsedSeconds` が更新され、live status bar の `mm:ss` 表示が変わる
- `ERROR` action で error 画面が `Connection failed / Check phone app / Press retry` を表示

### 2.2 `apps/evenhub-app/tests/integration/app-lifecycle.test.ts`

`App` クラスを mock DI（bridge / mic / session creator / RTC factory / audio attach）で組み立て、
`src/app.test.ts` でカバーされていない複合観点を補強する。

- `LANGUAGE_CHANGED` 後に `START_REQUESTED` を投げると、`createSession` の引数 `targetLanguage` が新しい言語コードになっている
- `output_transcript.delta` を 3 回（`Hello, ` / `world` / `.`）流すと、文末で finalize されて `activeSubtitle` に `Hello, world.` が現れる
- `PAUSE` / `RESUME` は `client.stop()` を呼ばずに status 表示だけを切り替える
- `STOP_REQUESTED` から `dispose` までで `client.stop` / `mic.track.stop` / `detachAudio` がそれぞれ 1 回呼ばれる
- 既存リスナーへの fan-out は dispatch ごとに 1 回（subscribe 時に動的に追加された listener は次の dispatch から）

### 2.3 `services/translation-backend/tests/integration/full-stack.test.ts`

`buildServer({ logger: false, config, fetchImpl })` で実 Fastify インスタンスを random port で起動し、
`apps/evenhub-app/src/backend/apiClient` を**実 fetch** で叩く end-to-end テスト。
OpenAI への upstream は引き続き `fetchImpl` で mock。

- 200 で `clientSecret` / `expiresAt` (ISO) / `model` が返り、upstream の `Authorization` ヘッダに `Bearer` が付き、生 userId は upstream に流れない
- targetLanguage が `auto` → 400 `invalid_request`、`apiClient` が `TranslationApiError` を投げる
- upstream 429 → `apiClient` 側で `code: 'rate_limited', status: 429` の `TranslationApiError`
- `GET /health` が 200 / `{ ok: true, version }` を返す（実 HTTP）

このテストは backend と app の **API contract 一致**を保証する。

---

## 3. 手動検証（Browser smoke / Even Simulator / 実機）

自動テストでは到達できない領域は手動で確認する。Claude が実行できる項目とユーザー実施項目を分けて記載する。

### 3.1 Browser smoke（Claude 実行可能）

mock bridge モードで Vite dev server を立ち上げ、初期 HUD が描画されるかを確認する。

```bash
pnpm --filter @even-rt/backend dev   # http://localhost:3000
PUBLIC_USE_MOCK_BRIDGE=true pnpm --filter @even-rt/evenhub-app dev   # http://localhost:5173
```

ブラウザで `http://localhost:5173` を開くと、`src/main.ts` が `App.boot()` を呼び、
mock bridge 経由で startup screen が描画される。Claude は Playwright MCP で
`mcp__playwright__browser_navigate` → `mcp__playwright__browser_take_screenshot` を撮る運用も可能。

### 3.2 Even Simulator（要ユーザー実施）

`evenhub` CLI のインストールと QR 経由の sideload は Even Realities 公式手順（設計書 §22）に従う。
Claude は CLI を install しない（`~/.claude/rules/supply-chain-security.md` に従い、未確認の外部ツール install をしない）。

手順:

1. `pnpm --filter @even-rt/backend dev` で backend 起動（`.env` 必須）
2. `pnpm --filter @even-rt/evenhub-app dev` で Vite 起動
3. `evenhub qr --url "http://<LAN_IP>:5173"` で QR 生成
4. Even Realities App から QR を読み取り、Even Simulator または実機で起動
5. 各画面の表示確認:
    - startup（`G2 Translate / Press to start / Swipe: language`）
    - permission（mic 許可未取得時）
    - connecting（`Connecting... / EN → JA`）
    - live（`EN→JA  LIVE ●  00:42` + 字幕本文）
    - paused（`Paused / Press to resume / Double press to exit`）
    - reconnecting（`Reconnecting...`）
    - error（`Connection failed / Check phone app / Press retry`）
    - exiting（`Closing...`）
6. ボタン入力の挙動確認:
    - single press: idle → start, live → pause, paused → resume, error → clear
    - double press: live/paused/reconnecting → exiting
    - swipe up/down: target 言語ローテーション

### 3.3 実機テスト（要ユーザー実施 / 設計書 §16.4）

| 観点 | 確認方法 |
| --- | --- |
| G2 表示の読みやすさ | 5 段階評価 4 以上（§17.2） |
| `textContainerUpgrade` のちらつき | 連続更新時の視認、§11 の 100〜250ms throttle で抑制できているか |
| Bluetooth bridge 遅延 | first subtitle latency 1.0〜2.0 秒以内（§11.1） |
| phone lock 時の挙動 | session 維持 / 字幕停止の切り替え |
| Even Realities App background 時の挙動 | bridge 切断 / 復帰時の再接続 |
| double press exit | 100% 成功（§17.1） |
| QR sideload | Even Hub CLI からのアプリ配布 |
| `private build`（`.ehpk` packaging） | `evenhub pack` でビルド、Developer Portal アップロード（§22） |

### 3.4 翻訳品質テスト（要ユーザー実施 / 設計書 §16.5）

実 OpenAI Realtime Translation API に対して、設計書のサンプル発話を流し、字幕の正確性と遅延を計測する。

評価観点:

- 日英会話 / 英日会話
- 固有名詞 / 数字 / 日付 / 金額
- 会社名 / 製品名 / 技術用語
- 騒音環境 / 早口 / 複数人発話 / code-switching

サンプル発話（設計書 §16.5）:

```
We are considering integration with your existing access control system.
Could you explain your pricing model and expected deployment timeline?
The pilot starts on June 15th and the budget is around 3 million yen.
Akerun supports cloud-based access management for offices and facilities.
```

計測指標（設計書 §11, §17.1）:

| 指標 | 合格ライン |
| --- | --- |
| first subtitle latency | 1.0〜2.0 秒以内 |
| incremental subtitle update | 250〜500 ms 間隔 |
| first translated audio | 2.0〜3.0 秒以内 |
| 起動成功率 | 20 回中 95% 以上 |
| WebRTC 接続成功率 | 20 回中 90% 以上 |
| reconnection 成功率 | 通信断テスト 80% 以上 |
| double press exit | 100% |

---

## 4. テスト実行コマンド

| 操作 | コマンド |
| --- | --- |
| 全パッケージの単体 + 統合テスト | `pnpm test` |
| カバレッジ付き | `pnpm test:coverage` |
| 単一パッケージ | `pnpm --filter @even-rt/evenhub-app test` |
| 特定ファイル（root） | `pnpm --filter @even-rt/evenhub-app exec vitest run tests/integration/state-and-hud.test.ts` |

CI 等では `pnpm typecheck && pnpm lint && pnpm test && pnpm build` を全て pass させること。

---

## 5. 参照

- 設計書: [`docs/realtime-translation-eveng2-mvp-design.md`](./realtime-translation-eveng2-mvp-design.md)（§11 レイテンシ / §16 テスト計画 / §17 評価指標 / §22 Even Hub packaging）
- Dev setup: [`docs/dev-setup.md`](./dev-setup.md)
- Architecture overview: [`docs/architecture.md`](./architecture.md)
