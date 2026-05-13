# Real-device validation guide (Phase 2 WS path)

このドキュメントは Phase 2 移行後の **§6 rollback gate** 通過条件のひとつ
「実機 1 ラウンド成功」を行うための手順書なのだ。Issue #6 の T7b
(物理削除) を実行する前に、必ず本ガイドのチェックリストを完走させる。

Phase 2 の実装 (PR #8〜PR-5b) は完了済み。**残るのは実機での動作確認だけ**。

---

## 0. 前提

- macOS 開発機 (backend + Vite を走らせる)
- iPhone (iOS 17+ 推奨) + Even Realities App インストール済み
- Even Realities G2 グラス + ペアリング済み
- Tailscale が両デバイスで利用可能 (同 tailnet に所属、または `tailscale serve` で公開)
- `.env` に `OPENAI_API_KEY` + `SAFETY_ID_SALT` が設定済み

## 1. ローカル起動 (開発機)

```bash
cd ~/ghq/github.com/daikw/even-realtime-translation

# 既存プロセスを掃除
pkill -f '@even-rt/backend' 2>/dev/null
pkill -f 'tsx watch' 2>/dev/null
pkill -f vite 2>/dev/null

# 依存と最新コードを同期
git checkout main
git pull --ff-only origin main
pnpm install --frozen-lockfile

# ベースライン確認 (全て green であること)
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build
```

期待値 (2026-05-13 時点):

- packages/shared 78 / services/translation-backend 69 / apps/evenhub-app 375
- **Total: 522 tests**, all green

## 2. backend + Vite 起動

別々のターミナルで:

```bash
# Terminal 1: backend (Fastify、WS relay 込み)
pnpm dev:backend
# → backend listening on http://127.0.0.1:3000

# Terminal 2: Vite (WebView 用 dev server、HTTPS + WS proxy)
pnpm dev:app
# → https://0.0.0.0:5173 で listen
```

確認ポイント:

- Backend ログに `backend listening on http://127.0.0.1:3000` が出る
- Vite が `@vitejs/plugin-basic-ssl` で自己署名証明書を発行する
- `https://127.0.0.1:5173` をブラウザで開いて HUD が描画される (mock bridge mode)

## 3. Tailscale Serve 設定 (iPhone から HTTPS 経由でアクセス)

iOS WKWebView は **Secure Context** (HTTPS) でないと一部 API が機能しない。
Tailscale Serve で自己署名証明書を有効な ER アプリ向け証明書に差し替える。

```bash
# 開発機: Vite を Tailscale 公開
tailscale serve --bg --https=443 https+insecure://localhost:5173

# 公開 URL の確認
tailscale serve status
# → https://<your-mac>.<your-tailnet>.ts.net/ → https+insecure://localhost:5173
```

公開 URL (例: `https://mac423-watanabe.tail123ab.ts.net`) を控える。

> **Note**: `VITE_HMR_HOST=<your-mac>.<your-tailnet>.ts.net` を `.env` に追加して
> `pnpm dev:app` を再起動すると、HMR (Hot Module Reload) が Tailscale 経由でも
> 動くようになる (vite.config.ts の hmr セクション参照)。

`.env` の `ALLOWED_ORIGINS` に Tailscale origin を追記:

```
ALLOWED_ORIGINS=http://localhost:5173,https://mac423-watanabe.tail123ab.ts.net
```

backend を再起動 (origin allowlist を読み直すため)。

## 4. iPhone 側準備

1. **iPhone を同じ tailnet にログイン** (Tailscale アプリで確認)
2. iPhone Safari で `https://<your-mac>.<your-tailnet>.ts.net/` を開く
   - HTTPS で接続できる (証明書 ✓ が出る) ことを確認
   - mock bridge mode で HUD が描画されることを確認
3. Even Realities App を起動 → 自作アプリの sideload エントリ
   (アプリ pack 手順は `docs/realtime-translation-eveng2-mvp-design.md` §22 参照)
4. 同じ URL を Even Hub の WebView 設定に登録 (アプリ pack で
   `app.json:entrypoint` 経由)

## 5. G2 装着 + 接続

1. G2 を装着して電源 ON、Even Realities App とペアリング済みであることを確認
2. iPhone で Even Realities App を起動
3. 自作アプリを起動
4. **HUD の startup screen** が G2 に表示される (boot 完了)
5. iPhone WebView は `bridge.audioControl(true)` を呼ぶ準備ができている

## 6. 翻訳テスト (happy path)

1. G2 のフレームをシングルタップ
   - 期待: HUD に `Connecting...` が表示される
   - backend ログ: `WS upgrade from https://<your-mac>....ts.net`
   - backend ログ: `connecting upstream wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate`
2. 1〜2 秒で
   - HUD: `LIVE` 状態に遷移、subtitle 表示エリアが空白で表示される
   - backend ログ: `upstream open` → `session.update sent`
   - backend ログ: `client { type: 'session.created' } sent`
3. 開発機マイクに向かって英語で発話
   - 例: `"Hello, this is a test of the realtime translation."`
4. **0.5〜2.0 秒以内に G2 字幕が表示される**
   - 例: `こんにちは、これはリアルタイム翻訳のテストです。`
   - backend ログ: `transcript.delta source=input text="..." count=N` (英語 deltas)
   - backend ログ: `transcript.delta source=output text="..." count=M` (日本語 deltas)

## 7. 言語切替テスト

1. G2 フレームをスワイプアップ / スワイプダウン (`subscribeInput`)
2. `targetLanguage` がローテーション (`en → ja → es → fr → ko → en`)
3. HUD 表示に新言語が反映される
4. backend ログ: `client.send({ type: 'language', target: 'ko' })` → `upstream session.update`
5. 次の発話の字幕が新言語で出る

## 8. 終了処理

1. G2 フレームをダブルタップ → `STOP_REQUESTED`
2. HUD: `Closing...` が表示される
3. backend ログ:
   - `client { type: 'close' } received`
   - `upstream session.close sent`
   - `grace period 6000ms started, waiting for trailing deltas...`
   - 6 秒後: `upstream closed`
4. HUD は `Closing...` のまま page container が closed されるまで残る
5. アプリ exit → Even Realities App 一覧に戻る

## 9. 期待されるレイテンシ baseline

T0.1 spike (`docs/phase2-migration-plan.md §10.3`) で計測した参考値:

| 観点 | t=0 起点 | 値 |
|---|---|---|
| WS open → session.created (downstream) | WS open | +17 ms |
| WS open → session.updated | WS open | +243 ms |
| Audio chunk #1 送信 → first output_audio.delta | audio 送信開始 | ~620 ms |
| Audio chunk #1 送信 → first transcript.delta | audio 送信開始 | ~730 ms |
| Audio flush 完了 → trailing transcript 終端 | flush | ~5.3 s |

実機で大きく超過する場合は Issue #3 (latency) に記録するのだ。

## 10. トラブルシュート

### `Connecting...` のまま固まる
- backend ログで `WS upgrade rejected: origin not allowed` → `.env` の `ALLOWED_ORIGINS` を確認
- backend ログで `WS upgrade rejected: per-IP limit` → 古い接続が残っている、ブラウザを完全に閉じて再試行
- backend が起動していない → `pnpm dev:backend` を確認

### `audioControl(true) returned false`
- G2 がペアリングされていない / 電源 OFF
- Even Realities App の OS マイク権限が許可されていない

### 字幕が出ない
- backend ログで `OpenAI WS connected` が出ているか
- `OPENAI_API_KEY` の有効性 (`.env` の値で curl テスト)
- `session.update` が送られているか (transcription model が `gpt-realtime-whisper` 設定済)

### `Mixed Content` エラー
- iPhone Safari が HTTPS 経由なのに backend を `http://` で呼んでいる
- Vite proxy `/api` 経由で同一 origin に統一されているはず、Vite の起動を確認

### G2 が黒画面
- HUD container がまだセットアップされていない → boot シーケンスの startup screen まで戻る
- `bridge.createStartUpPageContainer()` が success を返したか backend ログで確認

## 11. ロールバック判断

- **全 11 ステップが green に通る** → §6 rollback gate 通過。T7b (物理削除) に進む。
- **任意のステップで再現可能な失敗** → Issue #6 にコメントで再現条件 + 期待値 + 実測値を記録。
  Phase 2 を一時撤回するか、原因を特定して修正するかを判断。
- **`getUserMedia` 経路に戻したい場合**: Issue #7 の調査 (CONCLUSIVE_INFEASIBLE) によって
  WebRTC 経路は恒久的に動かないことが確定済み。**ロールバックしても解決しない**。
  代わりに git history (`git revert` PR #11 以降) で Phase 1 設計に完全に戻す。

## 付録: 自動ログ収集スクリプト

backend 側の重要イベントを抽出する awk フィルタ:

```bash
pnpm dev:backend 2>&1 | tee /tmp/backend.log | awk '
  /WS upgrade from/ { print }
  /upstream open/ { print }
  /session.update sent/ { print }
  /transcript.delta/ { print }
  /upstream closed/ { print }
  /error/ { print }
'
```

これを別ターミナルで走らせると流れが追いやすいのだ。

---

このガイドを完走したら **Issue #6 に「実機検証完走、§6 rollback gate 通過」と
コメント** してから T7b (物理削除) PR に進むのだ。
