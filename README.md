# Even G2 Realtime Translation HUD PoC

Even Realities G2 を「リアルタイム翻訳字幕 HUD」として利用する PoC。
スマホマイクで取得した音声を OpenAI Realtime Translation API で逐次翻訳し、G2 グラスに字幕として表示する。

設計の詳細は [`docs/realtime-translation-eveng2-mvp-design.md`](./docs/realtime-translation-eveng2-mvp-design.md) を参照。

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
| `PUBLIC_BACKEND_URL` | WebView から backend に到達する URL (vite `PUBLIC_*` envs) |

## Milestones

- **M0** Repository scaffold (this commit)
- **M1** packages/shared の型・言語定義・formatting utilities
- **M2** services/translation-backend (Fastify + OpenAI client secret API)
- **M3** apps/evenhub-app: Even bridge layer
- **M4** apps/evenhub-app: realtime/ WebRTC client
- **M5** apps/evenhub-app: hud/ subtitle buffer + layout + screens
- **M6** apps/evenhub-app: state reducer + main glue
- **M7** 統合テスト + Test Plan
- **M8** Security review + 最終 PR

## Even Hub packaging notes

- `apps/evenhub-app/app.json` の `permissions[].whitelist` は PoC 用に `http://localhost:3000` を含む。本番 backend ドメインが決まったら差し替える。
- Even Hub SDK は `@evenrealities/even_hub_sdk@0.0.10` を exact pin。設計書 §9.1 の `min_sdk_version` と一致。
- QR sideload や `evenhub pack` の手順は `docs/realtime-translation-eveng2-mvp-design.md` §22 を参照。

## Supply-chain notes

- 全依存は `--save-exact` で固定し、`pnpm-lock.yaml` をコミット。
- pnpm の install script は default で無効 (`Ignored build scripts: esbuild` の警告は意図的)。エディタ向けの native binary が必要になった時点で `pnpm approve-builds` で個別に許可する。
- 依存追加時は `~/.claude/rules/supply-chain-security.md` の手順に従い、registry 上のメタを目視確認する。

## License

MIT. See [`LICENSE`](./LICENSE).
