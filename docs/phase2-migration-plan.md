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
  ├─ (resampler は packages/shared/src/audio/pcm.ts に集約。
  │   apps 側は import only。docs:38 / docs:82 の表記揺れ解消)
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
        │     session.update                          (target language, transcription model, noise_reduction)
        │     session.input_audio_buffer.append       (base64 PCM16 24 kHz, continuous)
        │     session.close                           (graceful shutdown; WS still has trailing events to flush)
        │     NO input_audio_buffer.commit / response.create — translation
        │     sessions stream output without those turn-lifecycle calls.
        │     IMPORTANT: client→server event types are all `session.` prefixed
        │     (T0.1 finding 2026-05-11, §10.3). Unprefixed names are rejected
        │     with "Invalid value … Supported values are: 'session.update',
        │     'session.input_audio_buffer.append', and 'session.close'."
        └─ relay OpenAI→client:
              session.created / session.updated → backend logs metadata; first frame triggers `{type:'session.created'}` to client
              session.output_transcript.delta  → frontend transcript.delta (source='output')
              session.input_transcript.delta   → frontend transcript.delta (source='input')
              session.output_audio.delta       (observed 19200 bytes / 400 ms fixed frames; treat as variable-length to stay forward-compatible)
              error                            → frontend error (normalised to {code, message})
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
| (なし) | `packages/shared/src/audio/pcm.ts` (resampler / S16LE helpers — pure func を shared に集約) |
| (なし) | backend WS relay (`services/translation-backend/src/realtime-ws.ts`) |

## 3. Task breakdown

> 並列実行の観点で粒度を分けている。順序の依存は `→` で示す。

### Step 0 — Spike (Day 0)

- **T0.1**: OpenAI Realtime Translation WebSocket を Node CLI から smoke する (commit しない script)。**実行済 (2026-05-11)、結果は §10.3 と Issue #6 参照**。
  - URL: `wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate`
  - Headers: `Authorization: Bearer ${OPENAI_API_KEY}`, `OpenAI-Safety-Identifier: <hash>`
  - 流す event: `session.update` で `audio.input.transcription.model` + `audio.output.language` + `audio.input.noise_reduction` を設定 → **`session.input_audio_buffer.append`** を **base64 PCM16 24 kHz mono** で連続送信。最後に **`session.close`** で graceful shutdown。**`commit` / `response.create` は使わない** (Translation session は continuous、turn-lifecycle 不要)。
  - 受け取る event: `session.created` / `session.updated` / `session.output_transcript.delta` / `session.input_transcript.delta` / `session.output_audio.delta` / `error`。
  - 確定 (T0.1 実行 2026-05-11):
    - 24 kHz PCM16 mono は正常動作。16 kHz 経路は未検証 (resampler は frontend で実施するので不要)
    - `session.output_audio.delta` の frame サイズは **19200 bytes 固定** (= 9600 samples = 400 ms @ 24kHz mono) を観測。1 セッション 21 frame 全て同サイズ。**実装は可変長対応のまま**（API 仕様で固定保証は未確認、forward-compat 確保）。
    - First `session.output_audio.delta` レイテンシ: WS open から **+2211ms** (うち session.update→updated +250ms、audio chunk 開始から +500ms 程度) — Issue #3 ベースライン
    - First `session.*_transcript.delta` レイテンシ: WS open から **+2321ms**
    - トレーリング deltas は audio flush 完了から ~5s 後まで継続。stop 実装は **grace period (推奨 6s 以上)** が必要。
    - `audioEvent.audioPcm` の chunk size は実機検証で確認 (本 spike は 100 ms = 9600 bytes @ 24kHz で smoke 済み、実機は 16 kHz 入力で 3200 bytes/100ms 想定)
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
  - 初期送信 (session.update): source-language transcript も backend → client にリレーするので、`audio.input.transcription.model` を **明示的に** 指定する必要がある (公式 Live Translation guide)。
    ```ts
    {
      type: 'session.update',
      session: {
        audio: {
          input: {
            transcription: { model: 'gpt-realtime-whisper' },
            noise_reduction: { type: 'near_field' },
          },
          output: { language: targetLanguage },
        },
      },
    }
    ```
    `near_field` は phone 持ち想定。G2 のディスプレイ越し / 遠距離 mic にする場合は `far_field` も検討。
  - 双方向 relay (turn lifecycle 無し、continuous):
    - client `{type:'audio', pcm}` → OpenAI `{type:'session.input_audio_buffer.append', audio: <base64>}` をそのまま forward (resample は frontend 側で済ませている前提)。**T0.1 finding: OpenAI 側 client→server event は `session.` prefix 必須 (§10.3)**
    - client `{type:'close'}` → OpenAI `{type:'session.close'}` (graceful)。backend は OpenAI から trailing event を受け取り続けるため、`session.close` 送信直後に upstream を tear down しない。**grace period 6 秒** (T0.1 観測) で trailing deltas を flush してから upstream close。
    - OpenAI `session.created` / `session.updated` → backend で metadata 抽出、初回 `session.updated` または `session.created` を **frontend `{type:'session.created', meta:{...}}`** に変換して送る (T1.2 protocol 通り)
    - OpenAI `session.output_transcript.delta` → client `{type:'transcript.delta', source:'output', text}`
    - OpenAI `session.input_transcript.delta` → client `{type:'transcript.delta', source:'input', text}`
    - OpenAI `session.output_audio.delta` → client `{type:'audio.delta', pcm: <base64>}` (T0.1 観測: 19200 bytes / 400 ms 固定だが、可変対応を維持)
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

### Step 5 — App glue / config (transport を DI 境界として一本化)

rollback を確実にするため、AppDeps を **transport-agnostic** な形に再設計する。実装は `transport: 'webrtc' | 'ws'` の旗で切り替えるのではなく、`createTranslationRuntime()` の一本化された factory を AppDeps に渡す。

- **T5.1**: `apps/evenhub-app/src/realtime/runtime.ts` (新規) — 旧 WebRTC と新 WebSocket の共通インターフェイス
  ```ts
  export interface TranslationRuntime {
    start(opts: {
      targetLanguage: LanguageCode
      onOutputTranscriptDelta: (d: TranscriptDelta) => void
      onInputTranscriptDelta?: (d: TranscriptDelta) => void
      onAudioDelta?: (samples: Int16Array) => void
      onStateChange: (s: ConnectionStatus) => void
      onError?: (e: Error) => void
    }): Promise<void>
    stop(): Promise<void>
    sendLanguageUpdate(target: LanguageCode): void
  }

  export interface TranslationRuntimeFactory {
    create(): TranslationRuntime
  }
  ```
  実装は `createWebSocketRuntime()` と `createWebRtcRuntime()` (legacy) の 2 系統。
- **T5.2**: `apps/evenhub-app/src/app.ts` の AppDeps を書き換え
  - 旧 `acquireMic: () => Promise<MediaStream>` / `createRtcClient: (opts) => ...` を撤去
  - 新 `translationRuntime: TranslationRuntimeFactory` 1 つに集約 (mic 取得は runtime 側の責務に内包)
  - rollback 時は `translationRuntime = createWebRtcRuntimeFactory()` に差し替えるだけで戻る (acquireMic の MediaStream 前提も消える)
- **T5.3**: `apps/evenhub-app/src/config.ts`
  - 新規 env: `PUBLIC_REALTIME_WS_URL` (default `/api/realtime/ws` → 同一 origin。WS proxy 経由)
  - 新規 env: `PUBLIC_TRANSPORT` (`'ws' | 'webrtc'`、default `'ws'`)。rollback 時に env で切替
- **T5.4**: `apps/evenhub-app/vite.config.ts`
  - 現行 HTTP proxy 設定に **`ws: true` を追加**して WebSocket upgrade を proxy できるようにする
    ```ts
    proxy: {
      '/api': {
        target: BACKEND_PROXY_TARGET,
        changeOrigin: true,
        secure: false,
        ws: true,            // ← NEW: WebSocket upgrade を中継
      },
    }
    ```
  - これで client は同一 origin `wss://<host>/api/realtime/ws` で接続、Vite が backend に upgrade を proxy
- **T5.5**: `apps/evenhub-app/app.json`
  - `permissions` に `g2-microphone` を追加。`phone-microphone` は同時保持 (Discord #7 回答待ちで rollback 容易性のため。回答後にどちらか削る)
- **T5.6**: 既存 `app.test.ts` を新 AppDeps 形に書き換え。旧 `acquireMic` / `createRtcClient` 引数は撤去、新 `translationRuntime` を mock で差し替え

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

> **Status (2026-05-13, PR-5)**: T7.3 / T7.4 / T7.5 / T7.6 完了。T7.1 と T7.2 は banner を追加した状態で停止 — section-by-section 書き換えは PR-5b (App refactor) と同時に行う。

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
T0.1 (OpenAI WS smoke)   ──→ T2 (backend WS) ─┐
T0.2 (stateful mock bridge) ─→ T3 (bridgeMic) ─┤
T1.2 (shared WS protocol)   ─→ T2, T4         ─┤
T1.1 (shared PCM utils)     ─→ T4             ─┤
                                              ├─→ T4 (frontend WS client) ─→ T5 (App glue) ─→ T7a (docs+deprecate)
                                              │                                              │
                                              │                                              └─→ (rollback gate) ─→ T7b (削除)
                                              │
T6 (audio output)        ──────────────────── (after T5)
```

明示的依存:
- **T0.1**: T2 着手前に OpenAI WS の生 protocol を確認 (event 名 / sample rate / commit 不要の挙動)
- **T0.2**: T3 のテスト容易性のために先行 (mock bridge を stateful 化)
- **T1.1 (pcm.ts)**: T4 が import (resample を frontend で実行)
- **T1.2 (realtime-ws types)**: T2 と T4 が共有 typed protocol として使用 → 2 つを並列実装する場合は T1.2 が先
- **T2 (backend)** と **T3 (bridgeMic)** は他に依存無し、並列可
- **T4 (WS client)** は T1.1 + T1.2 + T3 完了後
- **T5 (App glue)** は T4 完了後 + T2 が dev で動作可能 (integration test に必要)
- **T7a** は Plan merge と同時に着手可、コードはまだ Step 5 完了後
- **T7b** は §6 rollback gate (Discord 回答 + 実機 1 ラウンド成功) 通過後

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

1. 旧 `phoneMic.ts` / `webrtcTranslationClient.ts` / `sdp.ts` を Step 7b で削除する前は **deprecated だが動くまま** (`@deprecated` JSDoc のみ)
2. **AppDeps の `translationRuntime` を差し替える** だけで戻る — T5.1 で導入する `TranslationRuntimeFactory` は WS / WebRTC の 2 実装を持ち、production 切替は `PUBLIC_TRANSPORT` env のみ
3. backend は `/api/openai/.../session` (WebRTC client secret 発行) と `GET /api/realtime/ws` を **同時保持** 。frontend 側だけ revert すれば WebRTC 経路が復活
4. `app.json` の `phone-microphone` も同時保持なので permission manifest の roll back 不要
5. Step 7b (物理削除) は **Discord 回答 + 実機 1 ラウンド成功** の両方が満たされた後にのみ実行

## 7. Open questions (Plan を実装に移す前に確認したい)

> Codex レビュー (BLOCKING / HIGH) で確定した事項は本文に取り込み済み。残る未確認は以下:

1. ~~OpenAI WS endpoint~~ → **確定**: `wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate` (T0.1 実走で 200 ok 確認済 §10.3)
2. ~~audio sample rate~~ → **確定**: 24 kHz PCM16 base64 mono。frontend で必ず resample。
3. ~~`session.update` を先に送る必要があるか~~ → **確定** (T0.1 §10.3): session.update を最初に送れば、その後の `session.input_audio_buffer.append` は session.updated 受信を待たずに送ってよい (内部で順序保証)。デフォルト session の output language は `es` だった。
4. `audioEvent.audioPcm` の chunk サイズが固定 (100 ms = 3200 bytes) か可変か。SDK type 上は固定保証なし。**実機で確認** (T0.1 spike は 24 kHz fixture のため代替不可)
5. ~~`output_audio.delta` の frame 長~~ → **暫定確定** (T0.1 §10.3): 19200 bytes = 400 ms 固定を観測 (n=21、min=max=avg=19200)。API 仕様で固定保証は未確認、実装は可変対応のまま。
6. `app.json` で旧 `phone-microphone` permission を **残したまま** WS 経路を動かしたとき、Even Realities App 側に warning などが出るか (Discord #7 で聞く)。
7. **NEW** `session.close` 送信後の OpenAI 側 tear-down タイミング: trailing deltas が ~5s 続く (T0.1 観測)。**backend 側は client `close` → OpenAI `session.close` 送信後、grace period 6s 以上待ってから upstream WS を close する**。早期切断すると trailing transcript が落ちる。

## 8. Acceptance criteria

### 8.1 自動テスト
- [ ] テスト全 pass。書き換え前の baseline (packages/shared 61 / backend 50 / app 311 — `pnpm -r test` 2026-05-11 時点) と **同等以上**。新規ファイル分は include 追加、削除ファイル分は exclude 整理。
- [ ] coverage 80% threshold 維持
- [ ] typecheck / lint / build 全 green
- [ ] PR レビュー (security-reviewer / codex agent) で CRITICAL/HIGH 0

### 8.2 OpenAI WS smoke (T0.1 spike) — ✅ 完了 (2026-05-11, §10.3)
- [x] CLI script で `wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate` に接続成功
- [x] 初期送信した `session.update`（input.transcription / output.language / noise_reduction）に対し `session.updated` イベント受信
- [x] base64 24 kHz PCM16 を **`session.input_audio_buffer.append`** (prefix 必須、§10.3) で連続送信 → `session.output_transcript.delta` 受信
- [x] 同時に `session.input_transcript.delta` を受信できることを確認 (input transcription が configured)
- [x] `session.output_audio.delta` の典型 frame 長を 1 セッション中 21 frame 記録: 19200 bytes 固定 (400 ms @ 24kHz)
- [x] First audio delta: +2211 ms / first transcript delta: +2321 ms (Issue #3 ベースライン)
- [x] `session.close` 後の trailing deltas を観測: ~5 秒継続

### 8.3 実機検証 (手動 checklist)
- [ ] `.env`:
  - [ ] `BACKEND_HOST=127.0.0.1`、backend は loopback のみ (LAN 公開しない)
  - [ ] `ALLOWED_ORIGINS=http://localhost:5173,https://<tailscale-fqdn>` — Tailscale Serve origin を追加 (WS preValidation で必要)
  - [ ] `OPENAI_API_KEY` / `SAFETY_ID_SALT` が `services/translation-backend/src/config.ts` で readRequiredString に通る形
  - [ ] `PUBLIC_REALTIME_WS_URL` 未指定 → default `/api/realtime/ws` で同一 origin
  - [ ] `PUBLIC_TRANSPORT=ws` (default)
- [ ] `vite.config.ts` の proxy で `'/api'` が `ws: true` 有効
- [ ] `tailscale serve --bg https+insecure://localhost:5173` 経由で Phone から WebView load
- [ ] G2 装着、bridge boot 成功 (startup screen 表示)
- [ ] G2 frame タップ → `Connecting...` → `LIVE` 遷移
- [ ] 発話 1 〜 2 秒で字幕が出始める (`session.output_transcript.delta` が backend → client → SubtitleBuffer に流れる)
- [ ] backend ログに以下が出る:
  - [ ] `WS upgrade from <origin>`
  - [ ] `OpenAI WS connected`
  - [ ] N 件の `transcript.delta relayed`
  - [ ] session duration / chunk count の summary
- [ ] Double tap → `Closing...` → cleanup
- [ ] §6 rollback ゲート条件 (Discord #7 回答 + 上記実機 1 ラウンド成功) が満たされない限り Step 7b (物理削除) は実行しない

### 8.4 ドキュメント
- [ ] `docs/realtime-translation-eveng2-mvp-design.md` が新アーキテクチャと整合
- [ ] `docs/test-plan.md` を WS 経路向けに更新、テスト件数も実値に
- [ ] README の Current Status / Milestone を更新

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

## 10. Codex reviews — 反映ログ

### 10.1 1st review (2026-05-11)

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
| **L-2** | mock bridge を stateful 化 | T0.2 を expand |

### 10.2 2nd review (2026-05-11、反映後の再レビュー)

判定: **APPROVE_WITH_CONDITIONS**。BLOCKING 0 / HIGH 3 / MEDIUM 3 / LOW 0。前回 13 件は M-1 のみ部分対応で残りは OK。新規 6 件を反映:

| ID | 内容 | 対応 |
|---|---|---|
| **H-5** | `audio.input.transcription` (`gpt-realtime-whisper`) が `session.update` から欠落 | T2.2 の初期送信 payload に追記 |
| **H-6** | Vite proxy に `ws: true` が plan に書かれていない | T5.4 を新設して明記 |
| **H-7** | rollback の DI 切替が抽象すぎる | T5.1 で `TranslationRuntime` interface + factory 一本化、§6 を更新 |
| **M-5** | §4 dependency graph 自己矛盾 (T0/T1/T2/T3) | §4 を書き直し、各 step の入出依存を明示 |
| **M-6** | resampler 配置が `apps/` と `packages/shared/` で割れている | `packages/shared/src/audio/pcm.ts` に集約、§2.1 図と §2.3 表を整合 |
| **M-7** | §8 受け入れ条件の手動 checklist 不足 | §8 を 4 段 (自動 / WS smoke / 実機 / docs) に分割、Tailscale Serve origin・proxy ws・OpenAI smoke 期待 event を明記 |

API contract 大枠 (endpoint, Bearer auth, Safety Identifier header) は公式 docs で再確認済みで問題なし。

### 10.3 T0.1 spike findings (2026-05-11)

実走 (`/tmp/phase2-spike/spike.mjs`、英語スピーチ 7.5 秒、`say -v Samantha` → `afconvert` で 24 kHz PCM16 mono WAV)。詳細ログは Issue #6 コメント参照。本 plan へ反映済み箇所は §2.1 / §3 T0.1 / §3 T2.2 / §7 / §8.2。

#### Plan 想定と異なった点 (= 訂正済み)

| # | 想定 (旧 plan) | 実 API 挙動 | 反映先 |
|---|---|---|---|
| **F-1** | client→server event: `input_audio_buffer.append` | **`session.input_audio_buffer.append`**。`session.` prefix 必須。エラー: `"Invalid value: 'inp...end'. Supported values are: 'session.update', 'session.input_audio_buffer.append', and 'session.close'."` | §2.1, §3 T0.1, §3 T2.2 |
| **F-2** | client→server で WS frame close するだけで OK | **`session.close`** を送るのが正式 (graceful)。送信後も trailing deltas が ~5s 続く | §2.1, §3 T0.1, §3 T2.2 (grace period 6s)、§7 q7 NEW |
| **F-3** | `output_audio.delta` は可変長 | 観測上は **19200 bytes / 400 ms 固定** (n=21 frame、全て同サイズ)。実装は forward-compat のため可変対応を維持 | §2.1, §7 q5, §8.2 |
| **F-4** | session.update を送らないと音声が処理されないかも | session.update 直後に audio chunk を流して問題なし。session.updated 受信を待つ必要なし。デフォルト session の language は `es` だった | §7 q3 |

#### Plan 通りだった点 (確認のため記録)

- URL: `wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate` ✓
- Auth: `Authorization: Bearer <api-key>` + `OpenAI-Safety-Identifier: <sha256>` ヘッダ ✓
- `session.update` payload (audio.input.transcription.model / audio.input.noise_reduction / audio.output.language) ✓
- `commit` / `response.create` 不要 ✓
- Server→client event 名 (session.created / session.updated / session.input_transcript.delta / session.output_transcript.delta / session.output_audio.delta / error) ✓
- 24 kHz PCM16 mono 入力 ✓

#### Latency baseline (Issue #3 連動)

WS open を t=0 として:

- session.update 送信: +0 ms (open 直後)
- session.created 受信: +17 ms
- session.updated 受信: +243 ms
- 最初の audio chunk 送信: +102 ms (session.updated より先)
- **first session.output_audio.delta**: +620 ms (audio 送信開始から)、WS open から **+2211 ms**
- **first session.*_transcript.delta**: +730 ms (audio 送信開始から)、WS open から **+2321 ms**
- audio flush 完了から trailing input_transcript.delta 終端まで: ~5.3 秒
- audio flush 完了から trailing output_transcript.delta 終端まで: ~6.5 秒

→ T2.2 の close 実装は **`session.close` 送信 → upstream close まで 6 秒以上の grace period** を持つ。早期切断すると後半の翻訳が落ちる。

#### Smoke 実行 artefact

- `/tmp/phase2-spike/spike.mjs` (commit せず)
- `/tmp/phase2-spike/sample-24k.wav` (`say -v Samantha` + `afconvert -f WAVE -d LEI16@24000 -c 1`)
- `/tmp/phase2-spike/spike2.log` (正常 run の full log)
