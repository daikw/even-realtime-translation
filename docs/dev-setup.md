# Dev Setup

PoC を手元で立ち上げるための最小手順。実機検証手順は [`docs/test-plan.md`](./test-plan.md#33-実機テスト要ユーザー実施--設計書-164) を参照。

---

## Prerequisites

- Node.js 20 以上 (`.nvmrc` 参照)
- pnpm 10 系（root の `packageManager` で固定済み）
- OpenAI API key — `gpt-realtime-translate` モデルの利用権限が必要
- 実機 / Simulator 検証する場合: Even Realities App と Even Hub CLI（`evenhub`）

---

## 1. Clone & install

```bash
git clone <repo-url> even-realtime-translation
cd even-realtime-translation
pnpm install --frozen-lockfile
```

`Ignored build scripts: esbuild` の警告は意図的（`~/.claude/rules/supply-chain-security.md` の lifecycle script 取り扱い）。
ローカルで esbuild の native binary が必要になった場合のみ `pnpm approve-builds` で個別に許可する。

---

## 2. 環境変数

```bash
cp .env.example .env
```

`.env` に最低限以下を設定する（git 管理外）。

| Key | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | backend のみで使用。WebView へは渡さない（§10.1） |
| `SAFETY_ID_SALT` | `OpenAI-Safety-Identifier` 生成用の salt。固定値の例: `openssl rand -base64 32` |
| `BACKEND_PORT` | backend listen port。省略時 `3000` |
| `ALLOWED_ORIGINS` | カンマ区切りの CORS allowlist。省略時 `http://localhost:5173` |
| `PUBLIC_BACKEND_URL` | WebView から backend に到達する URL。省略時 `http://localhost:3000` |
| `PUBLIC_OPENAI_BASE_URL` | OpenAI Realtime API の base URL。省略時 `https://api.openai.com` |
| `PUBLIC_MODEL_NAME` | 翻訳モデル名。省略時 `gpt-realtime-translate` |
| `PUBLIC_USE_MOCK_BRIDGE` | `"true"` で Even Hub bridge をモックに差し替え（ブラウザ単体動作用） |

salt の生成例:

```bash
echo "SAFETY_ID_SALT=$(openssl rand -base64 32)" >> .env
```

---

## 3. Backend 起動

```bash
pnpm --filter @even-rt/backend dev
# tsx watch src/index.ts → http://localhost:3000 で listen
```

`/health` で稼働確認:

```bash
curl http://localhost:3000/health
# {"ok":true,"version":"..."}
```

---

## 4. WebView app 起動

別ターミナルで:

```bash
PUBLIC_USE_MOCK_BRIDGE=true pnpm --filter @even-rt/evenhub-app dev
# vite → http://localhost:5173
```

ブラウザで `http://localhost:5173` を開くと、Even Hub bridge が無い環境では mock bridge にフォールバックして
startup screen（`G2 Translate / Press to start / Swipe: language`）が描画される。
DevTools コンソールで `App.boot completed` 系のログが見えていれば boot 成功。

`PUBLIC_USE_MOCK_BRIDGE` を外して実機 bridge を期待させる場合は、Even Realities App + Even Hub
（QR sideload 経由）を併用する必要がある。

---

## 5. テスト / Lint / Typecheck

```bash
pnpm test                # 全パッケージ単体 + 統合テスト
pnpm test:coverage       # カバレッジ付き
pnpm typecheck           # tsc --noEmit
pnpm lint                # eslint flat config
pnpm build               # shared / backend / app をビルド
```

詳細は [`docs/test-plan.md`](./test-plan.md) を参照。

---

## 6. QR sideload（実機 / Even Simulator）

`evenhub` CLI が必要。インストール手順は Even Realities 公式に従うこと
（このリポジトリの自動化スクリプトでは install しない — 設計書 §22）。

```bash
# 1. backend / app をローカルで起動
pnpm --filter @even-rt/backend dev
PUBLIC_USE_MOCK_BRIDGE=false pnpm --filter @even-rt/evenhub-app dev

# 2. LAN IP を確認（macOS: ifconfig | grep inet など）
LAN_IP=$(ipconfig getifaddr en0)

# 3. QR を生成（公式ドキュメント参照）
evenhub qr --url "http://${LAN_IP}:5173"
```

Even Realities App から QR を読み取ると、Simulator / 実機 G2 でアプリが起動する。

---

## 7. `.ehpk` packaging（private build / Developer Portal）

Production build を Even Hub の private build としてアップロードする手順。設計書 §22 に従う。

```bash
# 1. WebView app の dist/ を生成
pnpm --filter @even-rt/evenhub-app build

# 2. .ehpk にパック
evenhub pack apps/evenhub-app/app.json apps/evenhub-app/dist -o g2-translate.ehpk -c

# 3. Developer Portal にアップロードして実機で確認
```

`apps/evenhub-app/app.json` の `permissions[].whitelist` には PoC 用に `http://localhost:3000` を含む。
本番 backend ドメインが決まったら差し替えること（README 参照）。

---

## 8. トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| `OPENAI_API_KEY is required` で backend が落ちる | `.env` を作成し、API key と `SAFETY_ID_SALT` を入れる |
| WebView で `EvenBridgeInitError: timeout` | Even Hub の host が無い / 通信不可。`PUBLIC_USE_MOCK_BRIDGE=true` でブラウザ動作確認に切替える |
| `pnpm test` が node_modules 不整合で fail | `rm -rf node_modules && pnpm install --frozen-lockfile` で再生成 |
| Backend からの response が CORS エラーになる | `.env` の `ALLOWED_ORIGINS` を確認。Vite の dev port が変わっていれば追加 |
| `pnpm dev:app` で env が反映されない | `PUBLIC_*` プレフィックスのみが Vite から WebView に露出する仕様（`vite.config.ts` の `envPrefix`） |

---

## 9. 参照

- 設計書: [`docs/realtime-translation-eveng2-mvp-design.md`](./realtime-translation-eveng2-mvp-design.md)
- Test plan: [`docs/test-plan.md`](./test-plan.md)
- Architecture overview: [`docs/architecture.md`](./architecture.md)
- README（リポジトリ概観）: [`../README.md`](../README.md)
