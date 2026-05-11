# Phase 2 Migration Plan — Audio Source & Transport Rewrite

> Tracking issue: [#6](https://github.com/daikw/even-realtime-translation/issues/6). Discord follow-up: [#7](https://github.com/daikw/even-realtime-translation/issues/7).

## 1. Why we are rewriting the audio pipeline

実機検証 (2026-05-11) で **Phase 1 設計の前提が崩れた** ことが確定した。

| 観点 | Phase 1 (現状) | 実機での挙動 |
|---|---|---|
| Audio capture | `navigator.mediaDevices.getUserMedia({ audio: true })` | `NotAllowedError` (WKWebView policy で拒否) |
| Transport | OpenAI Realtime Translation **WebRTC** (`/v1/realtime/translations/calls`) | media stream 自体が取れず到達不能 |
| 設計書 §2 の根拠 | "WebView 標準 `getUserMedia()` が使える" | 公式 docs (`hub.evenrealities.com/docs`) で audio は `bridge.audioControl` のみ言及。`getUserMedia` の言及無し |

Even Hub の公式 audio 経路は `bridge.audioControl(true)` + `audioEvent.audioPcm` の **PCM push 経路**。これは設計書 §5.2 で「Phase 2」と呼んでいた経路だが、**Phase 1 から採用しないと実機が成立しない** ことが分かった。よって本 plan は「Phase 2 へ前倒し」ではなく「Phase 1 の前提誤りを訂正する書き換え」と位置付ける。

Codex の指摘 (PR #1, C-1/C-2/H-1) で「OpenAI Realtime Translation の event 名 / endpoint は実 API で確認すべし」と言われた点は、Simulator 経由で **公式仕様と一致** することは既に確認済み (`session.output_transcript.delta` / `session.input_transcript.delta` / `/v1/realtime/translations/calls` 全部適合)。本 plan の対象はあくまで audio capture + transport であり、API contract は変えない。

### Plan の取り得る転帰

1. **Discord (#7) で公式から「`getUserMedia` を opt-in で expose する方法あり」と返答** → Phase 2 移行は不要、本 plan は撤回して getUserMedia + WebRTC のまま継続。
2. **公式回答が「`bridge.audioControl` のみ」** → 本 plan の通り進める。
3. **回答無し or 不明** → 本 plan を進めつつ、`apps/evenhub-app/src/audio/phoneMic.ts` を即削除はせず deprecated として残し、ロールバック容易性を保つ。

## 2. Target architecture

### 2.1 Component diagram

```
G2 (mic)
  │  16 kHz S16LE PCM mono
  ▼
EvenAppBridge.audioControl(true)
  │  bridge.onEvenHubEvent → audioEvent.audioPcm: Uint8Array
  ▼
WebView (apps/evenhub-app)
  ├─ src/audio/bridgeMic.ts           ← NEW: pulls audioEvent chunks
  ├─ src/audio/pcmResampler.ts        ← NEW: 16 kHz → 24 kHz S16LE PCM (required, not optional)
  └─ src/realtime/websocketTranslationClient.ts  ← NEW
        │  WebSocket: wss://<vite-host>/api/realtime/ws   (same-origin via Vite proxy)
        ▼
services/translation-backend
  ├─ POST /api/openai/realtime/translation/session (kept ONLY for the legacy
  │                                                 WebRTC rollback path)
  └─ NEW: GET /api/realtime/ws       ← upgrade to WebSocket relay
        │
        │  OpenAI Realtime Translation WS (server-side)
        │   wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
        │   Authorization: Bearer ${OPENAI_API_KEY}        ← raw API key (server-only)
        │   OpenAI-Safety-Identifier: <sha256(salt + userId)>
        │
        ├─ relay client→OpenAI:
        │     session.update                   (target language)
        │     input_audio_buffer.append        (base64 PCM16 24 kHz, continuous)
        │     NO input_audio_buffer.commit / response.create — translation
        │     sessions stream output without those turn-lifecycle calls.
        └─ relay OpenAI→client:
              session.output_transcript.delta  → frontend transcript.delta
              session.input_transcript.delta   → frontend transcript.delta
              session.output_audio.delta       (variable-length base64 PCM16 24 kHz)
              error                            → frontend error
```

### 2.2 What stays the same

- HUD layer (`src/hud/*`) — subtitle buffer / layout / screens
- State machine (`src/state/*`) — 状態遷移は `connecting` → `live` のまま
- Even bridge layer (`src/even/{bridge,display,input,lifecycle,storage}.ts`) — そのまま流用
- HUD display layout (subtitle full-frame + 1×1 input list)
- `eventParser.ts` の `RealtimeServerEvent` discriminated union (event 名は同じ、transport だけ変わる)
- backend の `requestClientSecret` / OpenAI Safety Identifier hashing
- packages/shared — types / formatting / language

### 2.3 What gets replaced

| 旧 (削除予定だが移行期間は併存) | 新 |
|---|---|
| `apps/evenhub-app/src/audio/phoneMic.ts` | `apps/evenhub-app/src/audio/bridgeMic.ts` |
| `apps/evenhub-app/src/realtime/webrtcTranslationClient.ts` | `apps/evenhub-app/src/realtime/websocketTranslationClient.ts` |
| `apps/evenhub-app/src/realtime/sdp.ts` | (削除 — WebSocket では SDP exchange なし) |
| `apps/evenhub-app/src/audio/audioPlayer.ts` (MediaStreamTrack → `<audio>`) | `audioOutputBuffer.ts` (base64 PCM16 → AudioBufferSourceNode、optional) |
| (なし) | `apps/evenhub-app/src/audio/pcmResampler.ts` |
| (なし) | backend WS relay (`services/translation-backend/src/realtime-ws.ts`) |

## 3. Task breakdown

> 並列実行の観点で粒度を分けている。順序の依存は `→` で示す。

### Step 0 — Spike (Day 0)

- **T0.1**: OpenAI Realtime Translation WebSocket を Node CLI から smoke する (commit しない script)。
  - URL: `wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate`
  - Headers: `Authorization: Bearer ${OPENAI_API_KEY}`, `OpenAI-Safety-Identifier: <hash>`
  - 流す event: `session.update` で `audio.output.language` を設定 → `input_audio_buffer.append` を **base64 PCM16 24 kHz mono** で連続送信。**`commit` / `response.create` は使わない** (Translation session は continuous、turn-lifecycle 不要)。
  - 受け取る event: `session.output_transcript.delta` / `session.input_transcript.delta` / `session.output_audio.delta` / `error`。
  - 確認したいこと:
    - 24 kHz 必須を実機で再確認 (16 kHz 投げて拒否されるか / 自動 resample されるか)
    - `output_audio.delta` の frame 長 (200 ms 固定か可変か)
    - `audioEvent.audioPcm` の chunk size (BxNxM/even-dev は 100 ms = 3200 bytes を主張、SDK type 上は固定保証なし)
- **T0.2**: stateful な mock bridge を作る (`apps/evenhub-app/src/even/bridge.mock.ts` を拡張)
  - `audioControl(true/false)` の状態を保持し、`emitAudio(chunk: Uint8Array)` ヘルパーを expose
  - stop 後の emit は無視 (bridgeMic がきちんと off になっているか検証可能に)
  - WAV fixture を chunk 化して流すユーティリティ (`emitWavFile(path)`) があると bridgeMic 動作検証が楽

### Step 1 — packages/shared 拡張

- **T1.1**: `packages/shared/src/audio/pcm.ts` (新規)
  - `bytesToSamplesLE(buf: Uint8Array): Int16Array` — 16-bit LE エンコード/デコード helper
  - `samplesToBytesLE(samples: Int16Array): Uint8Array`
  - `resample16to24(samples: Int16Array): Int16Array` — **必須** (OpenAI translation WS は 24 kHz PCM16 を要求)。線形補間ベース pure 関数。
- **T1.2**: `packages/shared/src/types/realtime-ws.ts` — frontend↔backend WS protocol の typed union
  - client→server: `{ type: 'open', targetLanguage }`, `{ type: 'audio', pcm: base64 }`, `{ type: 'language', target }`, `{ type: 'close' }`
  - server→client:
    - `{ type: 'session.created', meta: { upstreamSessionId?, model, targetLanguage } }` (L-1 反映: debug 容易性のため metadata を含める。本文 / audio は含めない)
    - `{ type: 'transcript.delta', source: 'input'|'output', text }`
    - `{ type: 'audio.delta', pcm: base64 }` (24 kHz PCM16 可変長 frame; Step 6 で使う、初期実装は ignore でも OK)
    - `{ type: 'error', code, message }`
- **T1.3**: テスト追加 (resampler の波形保存、bytes ↔ samples 往復、resample 出力長 = 入力長 × 3/2)

### Step 2 — backend WS relay

- **T2.1**: 依存追加 (supply-chain-security ルール準拠、**runtime dependency** であり devDependencies ではない)
  ```bash
  # npm view で latest を確認した上で pin
  pnpm --filter @even-rt/backend add --save-exact @fastify/websocket@<exact> ws@<exact>
  pnpm --filter @even-rt/backend add -D --save-exact @types/ws@<exact>
  ```
  - `@fastify/websocket` は `dependencies` に。`ws` も明示的に exact pin (peer 依存をリポジトリで再現するため)。
  - register 順序: 既存 route plugin より **前** に `await app.register(websocket, { options: { maxPayload: 64 * 1024 } })` を実行する (Fastify は register 順で plugin tree を構築)。
- **T2.2**: `services/translation-backend/src/realtime-ws.ts` (新規)
  - WS upgrade route: `GET /api/realtime/ws`
  - **接続前検証** (`preValidation`):
    - `Origin` を `ALLOWED_ORIGINS` allowlist でチェック (CORS preflight は WS では走らないため preValidation で代替)
    - per-IP / per-user 接続上限 (initial: 2 connections / IP)
    - idle timeout (初期実装: 30 秒。pong/ping で延命)
  - 接続時に client から `{type:'open', targetLanguage}` を受け取り、targetLanguage を validate
  - safetyId を `computeSafetyIdentifier(salt, userId)` で生成
  - OpenAI Realtime Translation **WebSocket** (`wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate`) に **`Authorization: Bearer ${OPENAI_API_KEY}`** で接続
    - **重要**: backend が WS upstream を保持する場合は server-side API key を直接使う。`requestClientSecret` で発行する short-lived ephemeral token は browser/WebRTC 経路向け。WS server-to-server で使うと expiry race のリスクがある。
    - `OpenAI-Safety-Identifier` ヘッダで salted hash を送る
  - 初期送信: `{ type: 'session.update', session: { audio: { output: { language: targetLanguage } } } }`
  - 双方向 relay (turn lifecycle 無し、continuous):
    - client `{type:'audio', pcm}` → OpenAI `{type:'input_audio_buffer.append', audio: <base64>}` をそのまま forward (resample は frontend 側で済ませている前提)
    - OpenAI `session.output_transcript.delta` → client `{type:'transcript.delta', source:'output', text}`
    - OpenAI `session.input_transcript.delta` → client `{type:'transcript.delta', source:'input', text}`
    - OpenAI `session.output_audio.delta` → client `{type:'audio.delta', pcm: <base64>}` (可変長前提)
    - OpenAI `error` → client `{type:'error', ...}` (生 message ではなく `{code, message}` に正規化、API key 漏洩を防ぐ)
  - 接続切断時に OpenAI 側もクローズ。backend が先に切れた場合は client にも close frame を送る。
  - back-pressure: client→OpenAI 方向は本質的に buffer 不要 (mic 流量は固定)。OpenAI→client 方向は client が遅い場合 ws.bufferedAmount を観測し、閾値超で client を切断する。
- **T2.3**: `services/translation-backend/tests/integration/ws-relay.test.ts`
  - OpenAI WS を **in-process WS server** で mock (ws ライブラリそのまま使うか、`ws.Server` を `:0` random port で立てて baseUrl を inject)
  - 双方向 relay の path coverage: `session.update` 反映 / audio relay / transcript relay / error normalisation / 切断時 cleanup
- **T2.4**: rate limit / origin allowlist
  - HTTP 既存の `@fastify/rate-limit` は WS upgrade に効かないため、WS route 側で独自 counter (in-memory Map) を持つ
  - 詳細は Step 2 完了時に Issue #2 と統合検討

### Step 3 — frontend audio capture

- **T3.1**: `apps/evenhub-app/src/audio/bridgeMic.ts`
  ```ts
  export interface BridgeMicHandle {
    stop(): Promise<void>
    onPcm(handler: (samples: Int16Array) => void): () => void
  }
  export async function acquireBridgeMic(bridge: EvenAppBridge): Promise<BridgeMicHandle>
  ```
  - `bridge.audioControl(true)` を呼ぶ
  - `bridge.onEvenHubEvent` で `audioEvent.audioPcm` を listen
  - Uint8Array (S16LE) → Int16Array に decode して handler に渡す
  - `stop()` で `bridge.audioControl(false)` + unsubscribe
- **T3.2**: テスト
  - mock bridge から audio event を emit → handler が呼ばれる
  - stop 後は audio event を無視

### Step 4 — frontend WebSocket client

- **T4.1**: `apps/evenhub-app/src/realtime/websocketTranslationClient.ts`
  ```ts
  type Opts = {
    backendUrl: string             // wss://<host>/api/realtime/ws (or same-origin path)
    targetLanguage: LanguageCode
    micHandle: BridgeMicHandle
    onOutputTranscriptDelta: (d: TranscriptDelta) => void
    onInputTranscriptDelta?: (d: TranscriptDelta) => void
    onAudioDelta?: (samples: Int16Array) => void   // 24 kHz PCM16 frames
    onStateChange: (s: 'idle'|'connecting'|'connected'|'reconnecting'|'failed') => void
    onError?: (e: Error) => void
    wsImpl?: typeof WebSocket      // for tests
  }
  export function createWebSocketTranslationClient(opts: Opts): {
    start(): Promise<void>
    stop(): Promise<void>
    sendLanguageUpdate(target: LanguageCode): void
  }
  ```
  - 起動時に backend WS に接続、`{type:'open', targetLanguage}` を送信
  - mic chunks (`audioEvent` 単位) を `resample16to24` で 24 kHz PCM16 に変換 → base64 化 → `{type:'audio', pcm}` で backend へ送信。**resampler は必須**（OpenAI translation WS は 24 kHz 要求）。
  - server からの `transcript.delta` を `source` で分岐して on*TranscriptDelta に流す
  - server からの `audio.delta` を base64 → Int16Array に decode して `onAudioDelta` に渡す (初期は no-op handler)
  - server からの `session.created` メタを `console.debug` で記録 (DEV only)、debugging 用
- **T4.2**: `reconnect.ts` の `ReconnectController` を流用、`stop` → `start` で再接続
- **T4.3**: テスト
  - WebSocket を mock (jsdom 用に薄い fake WS) して happy path / disconnect / error
  - resampler を渡さないパスもテスト

### Step 5 — App glue / config

- **T5.1**: `apps/evenhub-app/src/app.ts`
  - `acquireMic` → `acquireBridgeMic` を呼ぶ DI 化 (既存の AppDeps は `acquireMic: () => Promise<MediaStream>`、新規は `acquireBridgeMic: (bridge) => Promise<BridgeMicHandle>`)
  - `createRtcClient` → `createWsClient` に切替 (型は別)
  - startSession の流れを書き換え
- **T5.2**: `apps/evenhub-app/src/config.ts`
  - 新規 env: `PUBLIC_REALTIME_WS_URL` (default `/api/realtime/ws` → 同一 origin)
- **T5.3**: `apps/evenhub-app/app.json`
  - `permissions` に `g2-microphone` を追加。`phone-microphone` は同時保持 (Discord 回答待ちで rollback 容易性のため。回答後にどちらか削る)
- **T5.4**: 既存 app.test.ts を新 deps 形に書き換え。AppDeps の `acquireMic` → `acquireBridgeMic`、`createRtcClient` → `createWsClient`

### Step 6 — audio output (任意)

OpenAI Realtime Translation WebSocket では `session.output_audio.delta` で **base64 PCM16 24 kHz mono** が返る。frame サイズは公式 docs で固定値を確認できておらず、**可変長** 前提で扱う:

- **T6.1**: `apps/evenhub-app/src/audio/audioOutputBuffer.ts`
  - base64 → Int16Array にデコード、frame サイズは受信 byte 長から duration を `samples / sampleRate` で計算
  - `AudioContext.createBuffer(1, samples, 24000)` + `copyToChannel` で AudioBuffer を組み立て
  - 連続する frame を `AudioBufferSourceNode` の chain で queue (`onended` で next frame schedule)
  - 再生は `AudioContext` 経由 (WKWebView でも有効、AudioWorklet は不要)
- **T6.2**: 設計書 §4.1 の "phone側での翻訳音声再生" 要件を達成

> M3 までは subtitle のみで OK な要件なので **T6.x は after Step 5**。Phase 2 移行の MVP には含めない。

### Step 7 — Docs & deprecation (削除は §6 ゲート通過後)

Step 7 は **deprecate-only**。実ファイル削除は §6 の rollback ゲート条件 (Discord 回答 + 実機 1 ラウンド成功) を満たした **後** に別 commit で行う。

#### Step 7a — Docs & deprecate marking (Plan merge と同時)

- **T7.1**: `docs/realtime-translation-eveng2-mvp-design.md` §2, §5.1, §6.3, §9.1, §14.1, §15.2 を書き換え。
  - "Phase 1 = bridge mic + WS" "Phase 2 = additional features (商談支援等)" に再定義
  - 旧 Phase 2 の G2 mic 内容は新 Phase 1 へ繰り上げ
- **T7.2**: `docs/test-plan.md` を WS 経路向けに書き換え。テスト件数 (backend 50 / app 311+) を現状値で更新。Phase 2 移行後の新規 test 件数は実装完了時点で再カウント。
- **T7.3**: `apps/evenhub-app/src/realtime/webrtcTranslationClient.ts`, `sdp.ts` の冒頭に `@deprecated` JSDoc を付ける。`@since` で deprecation 日付と削除予定条件をコメント。
- **T7.4**: `apps/evenhub-app/src/audio/phoneMic.ts` も同様に deprecation コメント
- **T7.5**: README の Current Status / Milestone を「Phase 1 = bridge mic + WS, 実機検証中」に更新
- **T7.6**: `app.json` の whitelist:
  - 新 `g2-microphone` permission を追加
  - 旧 `phone-microphone` も併存 (rollback 用)
  - `https://api.openai.com` origin は **削除しない** (rollback で WebRTC 経路に戻した場合に必要、また backend WS 経由でも内部 fetch は backend からなので不要だが過渡期は許容)

#### Step 7b — Physical removal (ゲート通過後、別 commit)

- **T7.7**: `webrtcTranslationClient.ts` + `sdp.ts` を削除、関連テストも削除
- **T7.8**: `phoneMic.ts` を削除
- **T7.9**: `app.json` から `phone-microphone` permission を削除、`https://api.openai.com` も削除
- **T7.10**: `vite.config.ts` の `@vitejs/plugin-basic-ssl` を撤去 (WS 経路は HTTPS 必須ではない可能性 — 別途確認)

## 4. Dependency graph

```
T0.1 (OpenAI WS spike) ─┐
T0.2 (mock mic helper)  ├─→ T2 (backend WS) ─┐
T1 (shared PCM utils)   ─┘                   ├─→ T4 (frontend WS client) ─→ T5 (App glue) ─→ T7 (docs/cleanup)
                                             │
T3 (bridgeMic)          ──────────────────────┘
T6 (audio output)       ──────────────────── (after T5)
```

- T1, T2, T3 は **完全並列**
- T4 は T1, T3 完了後
- T5 は T4 完了後
- T7 は T5 完了後 (docs と code cleanup は最後)

## 5. Test strategy

| Layer | Test type | Where |
|---|---|---|
| pcm.ts (resample) | Unit (pure func) | `packages/shared` Vitest |
| bridgeMic.ts | Unit (mock bridge) | `apps/evenhub-app` Vitest jsdom |
| websocketTranslationClient.ts | Unit (mock WS) | `apps/evenhub-app` Vitest jsdom |
| backend WS relay | Integration (in-process WS upstream mock) | `services/translation-backend` Vitest |
| Real device | Manual (Simulator + 実機 + Tailscale Serve) | `docs/test-plan.md` の §3 を流用 |
| OpenAI WS smoke | Manual (real API call from CLI script) | T0.1 spike |

`apps/evenhub-app` 全体の coverage threshold は 80% を維持。新規ファイルは coverage include に追加、削除ファイルは exclude に。

## 6. Rollback strategy

Phase 2 移行が失敗 (= 実機で別の blocker が出た / Discord で getUserMedia opt-in 方法判明) した場合:

1. 旧 `phoneMic.ts` / `webrtcTranslationClient.ts` / `sdp.ts` を Step 7 で削除する前は **deprecated だが動くまま**。`AppDeps` で DI を切り替えれば即戻る
2. backend は `/api/openai/.../session` も同時保持しているので、frontend 側だけ revert すれば WebRTC 経路が復活
3. `app.json` の `phone-microphone` も同時保持なので permission manifest の roll back 不要
4. Step 7 (削除) は **Discord 回答 + 実機 1 ラウンド成功** の両方が満たされた後にのみ実行

## 7. Open questions (Plan を実装に移す前に確認したい)

> Codex レビュー (BLOCKING / HIGH) で確定した事項は本文に取り込み済み。残る未確認は以下:

1. ~~OpenAI WS endpoint~~ → **確定**: `wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate`
2. ~~audio sample rate~~ → **確定**: 24 kHz PCM16 base64 mono。frontend で必ず resample。
3. backend が `session.update` を送る前に `input_audio_buffer.append` を流せるか (= 言語確定前の音声バッファリング)。T0.1 spike で確認。原則は session.update を最初に送る。
4. `audioEvent.audioPcm` の chunk サイズが固定 (100 ms = 3200 bytes) か可変か。SDK type 上は固定保証なし。T0.1 副次で確認。
5. `output_audio.delta` の frame 長 (200 ms 固定 / 可変 / 100 ms)。可変長前提で実装するが、典型値を T0.1 で記録しておくとレイテンシ計算に役立つ (Issue #3 と連動)。
6. `app.json` で旧 `phone-microphone` permission を **残したまま** WS 経路を動かしたとき、Even Realities App 側に warning などが出るか (Discord #7 で聞く)。

## 8. Acceptance criteria

- [ ] 実機 (G2 + Phone + Tailscale Serve) で `bridge.audioControl(true)` → 翻訳字幕表示まで到達
- [ ] backend ログに WS connect + relay 統計 (transcript delta 件数 / duration) が出る
- [ ] **OpenAI WS smoke** (T0.1 spike script) が success 終了する
- [ ] backend OpenAI WS smoke を `docs/test-plan.md` に手動チェックリストとして追記
- [ ] テスト全 pass。書き換え前の baseline (packages/shared 61 / backend 50 / app 311 — `pnpm -r test` 2026-05-11 時点) と **同等以上**。新規ファイル分は include 追加、削除ファイル分は exclude 整理。
- [ ] coverage 80% threshold 維持
- [ ] typecheck / lint / build 全 green
- [ ] `docs/realtime-translation-eveng2-mvp-design.md` が新アーキテクチャと整合
- [ ] PR レビュー (security-reviewer / codex agent) で CRITICAL/HIGH 0
- [ ] §6 rollback ゲート条件 (Discord 回答 + 実機 1 ラウンド成功) が満たされない限り Step 7b (物理削除) は実行しない

## 9. Estimated effort

| Step | 規模感 |
|---|---|
| T0 (spikes) | 0.5 day |
| T1 (shared) | 0.5 day |
| T2 (backend WS) | 1 day |
| T3 (bridgeMic) | 0.5 day |
| T4 (WS client) | 1 day |
| T5 (App glue) | 0.5 day |
| T6 (audio output) | 1 day (optional) |
| T7 (docs/cleanup) | 0.5 day |
| **合計 (T6 除く)** | **4.5 days** |

並列化で Wall-clock は 2-3 days まで圧縮可能 (Claude が swarm-dev で T1/T2/T3 を並列実装する場合)。

## 10. Codex review (2026-05-11) — 反映済み

Codex (cross-model) レビューで指摘された BLOCKING / HIGH / MEDIUM を本 plan に反映した。受領した指摘の対応状況:

| ID | 内容 | 対応 |
|---|---|---|
| **B-1** | OpenAI WS endpoint は `/v1/realtime/translations` (誤: `/v1/realtime`) | §2.1 / T0.1 / T2.2 / §7 訂正済み |
| **B-2** | backend WS は API key 直 Bearer 使用 (client secret 再発行 NG) | T2.2 + §2.1 図訂正、`requestClientSecret` は WebRTC rollback 用と明記 |
| **B-3** | Translation session は continuous、`input_audio_buffer.commit` / `response.create` 不要 | T0.1 / §2.1 図訂正 |
| **H-1** | 24 kHz PCM16 確定、resampler は必須 | T1.1 / T4.1 / §2.1 図訂正 |
| **H-2** | `@fastify/websocket` は `dependencies`、`ws` も明示 pin | T2.1 に新規追加 |
| **H-3** | WS Origin allowlist / maxPayload / idle timeout 明記 | T2.2 / T2.4 追記 |
| **H-4** | `output_audio.delta` frame 長は可変前提 | T6.1 / T1.2 訂正 |
| **M-1** | Step 7 cleanup と rollback §6 矛盾 → 分離 | Step 7a (deprecate) と 7b (削除) に分離 |
| **M-2** | backend WS register 順序明記 | T2.1 に明記 |
| **M-3** | app.json whitelist 更新方針 | T7.6 / Step 7b で明示 |
| **M-4** | テスト数値乖離 | 実際の baseline (`pnpm -r test` 2026-05-11) で更新、`docs/test-plan.md` の古い数値は T7.2 で同時 update |
| **L-1** | `session.created` に metadata 含める | T1.2 (server→client protocol) に追加 |
| **L-2** | mock bridge を stateful 化 | T0.2 を expand
