# Even G2 Realtime Translation HUD PoC

Even Realities G2 を「リアルタイム翻訳字幕 HUD」として利用する PoC。
**G2 マイク** で取得した音声を OpenAI Realtime Translation API で逐次翻訳し、G2 グラスに字幕として表示する。

設計の詳細は [`docs/realtime-translation-eveng2-mvp-design.md`](./docs/realtime-translation-eveng2-mvp-design.md) を参照。
Phase 2 移行（getUserMedia → bridge.audioControl + WebRTC → WebSocket）の経緯は [`docs/phase2-migration-plan.md`](./docs/phase2-migration-plan.md) を参照。

## Repository layout

pnpm workspace monorepo。

```
apps/
  evenhub-app/             # Even Hub WebView アプリ (vite + TypeScript + Even SDK)
services/
  translation-backend/     # Fastify backend: OpenAI client secret 発行 / CORS / rate limit
packages/
  shared/                  # 共有型 / 言語定義 / formatting utilities
docs/
  realtime-translation-eveng2-mvp-design.md
```

## Requirements

- Node.js 20 以上 (`.nvmrc` 参照)
- pnpm 10 系 (root の `packageManager` で固定)

## Setup

```bash
pnpm install
cp .env.example .env  # 必要な値を埋める
```

## Scripts

すべて root から workspace 横断で実行できる。

| Command | Description |
| --- | --- |
| `pnpm typecheck` | 全パッケージで `tsc --noEmit` |
| `pnpm lint` | flat config eslint をルートから |
| `pnpm format` | prettier で整形 |
| `pnpm test` | vitest を全パッケージで実行 (`--passWithNoTests`) |
| `pnpm test:coverage` | カバレッジ付き |
| `pnpm build` | 全パッケージビルド |
| `pnpm dev:backend` | Fastify backend を tsx watch で起動 |
| `pnpm dev:app` | Even Hub WebView app を vite dev server で起動 |

## Environment

`.env` は git 管理外。`.env.example` を参照。

| Key | Description |
| --- | --- |
| `BACKEND_PORT` | backend listen port (default 3000) |
| `ALLOWED_ORIGINS` | CORS allowlist (カンマ区切り) |
| `OPENAI_API_KEY` | OpenAI API key (backend のみで使用、WebView に渡さない) |
| `SAFETY_ID_SALT` | `OpenAI-Safety-Identifier` を生成するための salt |
| `PUBLIC_REALTIME_WS_URL` | Phase 2 backend WS relay path (default `/api/realtime/ws`、Vite proxy で同一 origin) |
| `PUBLIC_USE_MOCK_BRIDGE` | `"true"` で Even Hub SDK ハンドシェイクをスキップしてモックを使う (`pnpm dev` をブラウザ単体で動かすとき用) |

## Milestones

- **M0** Repository scaffold
- **M1** packages/shared の型・言語定義・formatting utilities
- **M2** services/translation-backend (Fastify + OpenAI client secret API)
- **M3** apps/evenhub-app: Even bridge layer
- **M4** apps/evenhub-app: realtime/ WebRTC client
- **M5** apps/evenhub-app: hud/ subtitle buffer + layout + screens
- **M6** apps/evenhub-app: state reducer + main glue
- **M7** 統合テスト + Test Plan
- **M8** Security review + 最終 PR

## 現在の実装状況

**Phase 2 移行完了 (2026-05-13)**。Phase 1 (`getUserMedia` + WebRTC) は実機 iOS WKWebView で恒久的に動作不能 (Issue #7、Discord 一次情報) と確定し、`bridge.audioControl(true)` + バックエンド WebSocket relay に切り替え済。実機検証も §6 rollback gate を通過し、レガシー WebRTC コード一式は T7b で物理削除済。詳細は [`docs/phase2-migration-plan.md`](./docs/phase2-migration-plan.md)、§6 rollback gate プレイブックは [`docs/real-device-validation.md`](./docs/real-device-validation.md)。

### 達成範囲 (2026-05-13 時点)

| Layer | Module | 状態 |
| --- | --- | --- |
| `packages/shared` | 型 / 言語 / formatting / safety identifier / PCM helpers + WS protocol types | ✅ 78 tests |
| `services/translation-backend` | Fastify + `/health` + `/api/events` + **`/api/realtime/ws` WS relay** | ✅ 38 tests |
| `apps/evenhub-app/even/` | bridge handshake / display throttle / input / lifecycle / storage / stateful mock | ✅ |
| `apps/evenhub-app/realtime/` | event parser / reconnect / **WebSocket translation client** / **TranslationRuntime** + WS factory | ✅ |
| `apps/evenhub-app/audio/` | **`bridgeMic.ts`** (G2 mic via bridge.audioControl) | ✅ |
| `apps/evenhub-app/hud/` | subtitle buffer / layout / screens | ✅ |
| `apps/evenhub-app/state/` | reducer / store / inputHandler | ✅ |
| `apps/evenhub-app/app.ts` | App lifecycle (DI、TranslationRuntime 経由) | ✅ |
| 統合テスト | state+hud / app-lifecycle | ✅ |

**Total: 430 tests (shared 78 / backend 38 / app 314)**, all green. (Phase 2 完了後、legacy WebRTC 経路 + 関連テストを T7b で削除済。)

### Phase 2 PR 履歴 (closed: Issue #6 / #7)

| PR | 内容 | step |
|---|---|---|
| #8 | Plan T0.1 spike findings (`session.*` prefix 必須、frame size、6 s grace period) | docs |
| #9 | shared: PCM helpers + WS protocol types | T1.1 + T1.2 |
| #10 | backend WS relay | T2 |
| #11 | frontend bridgeMic + WS client | T0.2 + T3 + T4 |
| #12 | TranslationRuntime abstraction + Vite ws:true + config envs + `@deprecated` markers | T5 partial + T7a partial |
| #13 | AppDeps refactor + app.test.ts rewrite + real-device validation guide | T5.2 + T5.6 + T7a |
| #14 | 物理削除 (`phoneMic` / `webrtcTranslationClient` / `sdp` / `audioPlayer` / `apiClient` / `openai.ts` / `phone-microphone` permission / 設計書 §6.3 / §9.1 / §14.1 / §15.2 inline rewrite) | **T7b** |

### 未達範囲（要ユーザー実施）

- **翻訳品質チューニング** — `gpt-realtime-translate` (preview) は中国語など一部 input 言語の transcribe が不安定。`docs/real-device-validation.md` §10 troubleshooting 参照。サポート言語拡大は upstream 側マター。
- **本番 backend デプロイ** — `apps/evenhub-app/app.json` の `network.whitelist` を本番ドメインに差し替え + `.ehpk` private build
- **M4 拡張機能** — IMU ジェスチャ、商談支援 / Akerun 文脈拡張（設計書 §24）

詳細は [`docs/test-plan.md`](./docs/test-plan.md) §3 を参照。

### 関連ドキュメント

- 設計: [`docs/realtime-translation-eveng2-mvp-design.md`](./docs/realtime-translation-eveng2-mvp-design.md)
- Test Plan: [`docs/test-plan.md`](./docs/test-plan.md)
- Dev Setup: [`docs/dev-setup.md`](./docs/dev-setup.md)
- Architecture: [`docs/architecture.md`](./docs/architecture.md)

## Even Hub packaging notes

- `apps/evenhub-app/app.json` の `permissions[].whitelist` は PoC 用に `http://localhost:3000` を含む。本番 backend ドメインが決まったら差し替える。
- `permissions` には `g2-microphone` を宣言。`phone-microphone` は T7b で削除済 (iOS WKWebView の `getUserMedia` 制約により Phase 1 経路は恒久的に動作不能、Issue #7)。
- Even Hub SDK は `@evenrealities/even_hub_sdk@0.0.10` を exact pin。設計書 §9.1 の `min_sdk_version` と一致。
- QR sideload や `evenhub pack` の手順は `docs/realtime-translation-eveng2-mvp-design.md` §22 を参照。

## Supply-chain notes

- 全依存は `--save-exact` で固定し、`pnpm-lock.yaml` をコミット。
- pnpm の install script は default で無効 (`Ignored build scripts: esbuild` の警告は意図的)。エディタ向けの native binary が必要になった時点で `pnpm approve-builds` で個別に許可する。
- 依存追加時は `~/.claude/rules/supply-chain-security.md` の手順に従い、registry 上のメタを目視確認する。

## License

MIT. See [`LICENSE`](./LICENSE).
