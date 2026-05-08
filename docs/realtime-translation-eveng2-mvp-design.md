Even G2 Realtime Translation HUD PoC 設計書

1. 概要

1.1 目的

Even Realities G2 を「リアルタイム翻訳字幕 HUD」として利用し、話者の音声を OpenAI Realtime Translation API で逐次翻訳し、翻訳結果を G2 のグラス表示に低レイテンシで提示する。

PoC の狙いは以下の 3 点。

1. スマートグラスらしい体験の検証
    スマホ画面を見ずに、視界内に翻訳字幕・キーワード・次アクションを表示できるかを確認する。
2. Even Hub SDK の実用性検証
    G2 の表示、入力、マイク、IMU、WebView、ネットワーク制約、アプリ審査に耐える構成を把握する。
3. AIアプリケーション基盤としての拡張可能性検証
    リアルタイム翻訳を足場に、商談支援、現場作業支援、Akerun連携、位置情報連動、社内API連携へ拡張できるかを検討する。

⸻

2. PoC の結論

最初の実装は以下を採用する。

Phase 1: phone mic + OpenAI WebRTC + G2字幕

理由は以下。

* ブラウザ/WebView標準の getUserMedia() と WebRTC を利用できるため、OpenAI側で推奨される実装に近い。
* WebView側で音声resamplingやPCM playbackを自前実装しなくて済む。
* OpenAI API keyをWebViewに置かず、backendから短命client secretを発行できる。
* G2 SDK部分は表示・入力・状態管理に集中できる。
* PoC初期の不確実性を、Even SDKのG2マイク仕様ではなく、UX検証に寄せられる。

次段階として、以下を検証する。

Phase 2: G2 mic + backend WebSocket + WASM audio processing + G2字幕

Phase 2 では、G2らしさが増す一方、G2マイク音声の取得、16kHz→24kHz resampling、base64 PCM16送信、ストリーム切断処理、WebView lifecycle対応が増える。

⸻

3. ユースケース

3.1 MVPユースケース

対面会話のリアルタイム字幕翻訳

* ユーザーがG2を装着する。
* スマホ上のEven Realities AppからPoCアプリを起動する。
* phone micで相手の発話を取得する。
* OpenAI Realtime Translation APIに音声をstreamする。
* 翻訳transcript deltaをG2に逐次表示する。
* 翻訳音声はphoneから再生する。
* G2/R1の入力で、言語切替・一時停止・終了を行う。

3.2 追加ユースケース

商談支援モード

リアルタイム翻訳のtranscriptを別のLLM処理に流し、以下をG2に表示する。

* 相手の関心トピック
* 固有名詞、数字、金額、日付
* 次に聞くべき質問候補
* TODO候補

現場作業支援モード

翻訳だけでなく、作業手順・注意事項・チェックリストを表示する。

* 展示会、現地デモ、設備点検、入退室管理、ロボット実験のガイド
* G2/R1入力による手順送り
* 音声メモから作業記録を生成

Akerun連携モード

Akerun APIや社内APIと連携し、場所・扉・予定に応じたHUDを表示する。

* 現在の訪問先
* 入館手順
* 対象ドアの状態
* unlock requestの導線
* 実験室/ロボットフィールドの作業モード

⸻

4. スコープ

4.1 Phase 1で作るもの

* Even Hubアプリ
* phone micによる音声入力
* OpenAI Realtime Translation WebRTC接続
* G2への翻訳字幕表示
* phone側での翻訳音声再生
* 言語切替UI
* pause/resume
* double pressによる終了
* backendによる短命client secret発行
* local storageによる設定保存
* simulator/実機での表示テスト
* .ehpk packaging

4.2 Phase 1で作らないもの

* G2マイク入力
* G2への音声出力
* BLE周辺機器スキャン
* Akerun API連携
* 位置情報連動
* speaker diarization
* 完全な商談要約
* 本番課金/ユーザー管理
* Even Hub public release

4.3 Phase 2以降で検証するもの

* G2 microphone capture
* WebSocket transport
* WASM audio worker
* VAD / noise suppression / resampling
* G2 IMUによるhead gesture
* 位置情報
* backend RAG / 社内API連携
* privacy-preserving redaction
* 商談メモ生成

⸻

5. システム構成

5.1 Phase 1 構成

Even G2 Glasses
  ├─ Display: translated subtitle HUD
  └─ Input: press / double press / swipe
Bluetooth
Phone
  └─ Even Realities App
       └─ WebView
            └─ Even Hub App
                 ├─ @evenrealities/even_hub_sdk
                 ├─ getUserMedia(phone mic)
                 ├─ RTCPeerConnection
                 ├─ OpenAI Realtime Translation WebRTC call
                 ├─ G2 display renderer
                 └─ settings UI
Backend
  ├─ POST /api/openai/realtime/translation/session
  ├─ OpenAI API key management
  ├─ client secret issuance
  ├─ audit/logging
  └─ optional usage metering
OpenAI API
  └─ /v1/realtime/translations/client_secrets
  └─ /v1/realtime/translations/calls

5.2 Phase 2 構成

Even G2 Glasses
  ├─ G2 microphone
  ├─ Display
  └─ Input / IMU
Bluetooth
Phone WebView
  ├─ Even Hub SDK audioControl(true)
  ├─ audioEvent: PCM 16kHz signed 16-bit LE mono
  ├─ Web Worker
  ├─ WASM audio pipeline
  │    ├─ resample 16kHz → 24kHz
  │    ├─ VAD
  │    ├─ chunking
  │    └─ optional noise suppression
  └─ WebSocket to backend
Backend Translation Gateway
  ├─ WebSocket from app
  ├─ OpenAI Realtime Translation WebSocket
  ├─ session.update target language
  ├─ session.input_audio_buffer.append
  ├─ transcript delta relay
  └─ translated audio relay to phone if needed

⸻

6. コンポーネント設計

6.1 Frontend / Even Hub App

責務:

* Even Hub SDK bridge初期化
* G2 page作成
* G2への字幕描画
* G2/R1入力イベント処理
* phone mic取得
* OpenAI WebRTC接続管理
* session状態管理
* target language切替
* local storageへの設定保存
* lifecycle event対応

主要モジュール案:

src/
  main.ts
  config.ts
  even/
    bridge.ts
    display.ts
    input.ts
    lifecycle.ts
    storage.ts
  realtime/
    webrtcTranslationClient.ts
    eventParser.ts
    language.ts
    reconnect.ts
  audio/
    phoneMic.ts
    g2Mic.ts               # Phase 2
    workerClient.ts         # Phase 2
  hud/
    subtitleBuffer.ts
    layout.ts
    screens.ts
    textFitter.ts
  backend/
    apiClient.ts
  state/
    appState.ts
    reducer.ts
  companion/
    settingsView.ts
    diagnosticsView.ts

6.2 Backend

責務:

* OpenAI API keyを保持する
* WebView向けに短命client secretを発行する
* 言語、ユーザー、session metadataを受け取る
* OpenAI Safety Identifier相当の識別子を付与する
* CORSを正しく返す
* 将来的にusage loggingやrate limitを行う

Phase 1で必要なAPI:

POST /api/openai/realtime/translation/session
Content-Type: application/json
{
  "targetLanguage": "ja",
  "sourceHint": "auto",
  "userId": "optional-even-user-id",
  "mode": "conversation"
}

Response:

{
  "clientSecret": "...",
  "expiresAt": "2026-05-08T12:34:56Z",
  "model": "gpt-realtime-translate"
}

6.3 OpenAI Translation Client

Phase 1ではWebRTCを使用する。

責務:

* backendからclient secretを取得
* navigator.mediaDevices.getUserMedia({ audio: true })
* RTCPeerConnection作成
* mic trackをpeer connectionに追加
* remote translated audio trackをphone audio elementに接続
* data channelでOpenAI eventsを受信
* session.output_transcript.delta を字幕バッファに渡す
* session.input_transcript.delta を診断/ログ用に保持する
* connection stateを監視し、UIに反映する

6.4 G2 Display Renderer

G2表示は通常HTMLではなく、Even SDKのcontainerとして構築する。

責務:

* 576×288pxキャンバスに収まるテキスト設計
* 翻訳字幕の差分更新
* 一定文字数以上の切り詰め
* 複数行表示
* 状態バー表示
* 通信状態・言語・mute状態の表示
* textContainerUpgrade による低フリッカー更新

画面構成案:

┌──────────────────────────────────────────────┐
│ EN→JA   LIVE ●                00:42          │
├──────────────────────────────────────────────┤
│ 連携の前提として、既存の入退室管理システムと │
│ どのように接続するかを確認したいです。       │
│                                              │
│                                              │
├──────────────────────────────────────────────┤
│ Press: pause   Swipe: lang   Double: exit     │
└──────────────────────────────────────────────┘

G2の制約を踏まえ、表示テキストは短く保つ。

推奨ルール:

* 字幕本文は最大 3〜5行
* 1行あたりの見かけ文字数は約20〜28文字を目安
* 古い字幕は流さず、直近発話単位で置き換える
* transcript deltaをそのまま追加し続けず、文末・句読点・一定文字数で整形する
* 画面下部に操作ヒントを常時表示する
* 長文は詳細表示モードではなく、phone側 companion UI に逃がす

6.5 Subtitle Buffer

Realtime APIはdelta単位で返すため、G2表示用にバッファリングする。

責務:

* deltaの連結
* 文境界推定
* 一定時間無音で確定扱い
* 文字数超過時の切り詰め
* G2向け改行
* 過剰更新の抑制

推奨動作:

- delta受信ごとにinternal bufferへ追加
- 100〜250ms間隔でG2表示をthrottle更新
- 句点/period/question mark/改行/長さ上限でsegment確定
- 確定segmentはhistoryへ移動
- G2にはactive segment + 直前segmentを表示

6.6 WASM Audio Worker / Phase 2

Phase 2で導入する。

候補処理:

* PCM16 parsing
* 16kHz→24kHz resampling
* chunk framing
* VAD
* silence trimming
* RMS level calculation
* clipping detection
* optional noise suppression
* optional local redaction trigger

推奨技術:

* Rust + wasm-bindgen
* Web Worker上で実行
* SharedArrayBufferはCOOP/COEP制約が面倒なため、初期PoCでは避ける
* AudioWorkletはWebView差分があるため、Phase 2.5以降

⸻

7. アプリ状態設計

7.1 状態一覧

type AppStatus =
  | 'booting'
  | 'permission_required'
  | 'idle'
  | 'connecting'
  | 'live'
  | 'paused'
  | 'reconnecting'
  | 'error'
  | 'exiting'

7.2 状態遷移

booting
  → permission_required
  → idle
  → connecting
  → live
live
  → paused
  → reconnecting
  → error
  → exiting
paused
  → live
  → exiting
reconnecting
  → live
  → error

7.3 状態別G2表示

状態	G2表示
booting	Starting...
permission_required	Open phone app to allow microphone.
idle	Press to start translation.
connecting	Connecting translation...
live	翻訳字幕
paused	Paused. Press to resume.
reconnecting	Reconnecting...
error	短いエラー + phone確認指示
exiting	Closing...

⸻

8. 入力設計

8.1 G2/R1操作

操作	Phase 1の動作
Single press	start / pause / resume
Double press	exit confirmation / shutdown
Swipe up	target language previous
Swipe down	target language next
Foreground enter	状態復元
Foreground exit	session維持またはpause
Abnormal exit	cleanup / reconnect

8.2 言語切替

初期対応:

* English → Japanese
* Japanese → English
* English → Spanish
* English → French
* English → Korean
* Auto → Japanese

MVPでは双方向会話の完全自動判定は狙わない。まずは「入力言語はauto、出力言語を選ぶ」設計にする。

8.3 Head Gesture / Phase 2以降

IMU利用案:

Gesture	動作
Nod	confirm / save memo
Shake	cancel / dismiss
Look down	pause subtitles
Look up	show summary

初期PoCでは誤検出リスクが高いため、操作本線には入れない。

⸻

9. 権限・manifest設計

9.1 Phase 1 app.json例

{
  "package_id": "com.photosynth.g2translator",
  "edition": "202601",
  "name": "G2 Translate",
  "version": "0.1.0",
  "min_app_version": "2.0.0",
  "min_sdk_version": "0.0.10",
  "entrypoint": "index.html",
  "permissions": [
    {
      "name": "network",
      "desc": "Connects to the translation backend and OpenAI realtime translation endpoints.",
      "whitelist": [
        "https://g2-translate.example.com",
        "https://api.openai.com"
      ]
    },
    {
      "name": "phone-microphone",
      "desc": "Captures speech from the phone microphone for live translation."
    }
  ],
  "supported_languages": ["en", "ja", "es", "fr", "ko"]
}

注意:

* Phase 1でWebViewからOpenAI WebRTC endpointへ直接SDPをPOSTする場合、https://api.openai.com をwhitelistに入れる必要がある。
* backend経由に完全proxyする場合はOpenAI originをwhitelistから外せるが、WebRTC media pathの扱いが複雑になる。
* network.whitelistはCORS回避ではないため、backend側CORSも別途必要。

9.2 Phase 2 app.json追加

{
  "name": "g2-microphone",
  "desc": "Captures speech from the glasses microphone for live translation."
}

Phase 2では phone-microphone と g2-microphone の両方を持たせ、設定画面で入力ソースを選択できるようにする。

⸻

10. セキュリティ・プライバシー設計

10.1 原則

* OpenAI API keyをWebViewに絶対に置かない。
* WebViewには短命client secretのみ渡す。
* 音声・transcriptを保存しない設定をデフォルトにする。
* ログには原則、本文を残さない。
* デバッグ時のみ明示的にtranscript loggingを有効化する。
* 送信先ドメインはapp.json whitelistに最小限だけ登録する。
* CORSはallowlistベースにする。
* client secret発行APIにrate limitを入れる。

10.2 backendログ

保存してよい情報:

* session id
* hashed user id
* target language
* start/end timestamp
* error type
* approximate duration
* usage metadata

保存しない情報:

* raw audio
* full transcript
* translated transcript
* 個人名、住所、電話番号、メールアドレス等の本文PII

PoC期間中に品質評価のためtranscript保存が必要な場合は、明示的なopt-inと保存期間を設ける。

10.3 Safety Identifier

OpenAI API呼び出し時に、ユーザー識別子を直接送らず、salted hashなどを用いる。

safety_identifier = sha256(app_specific_salt + even_user_uid)

10.4 Even Hub審査を意識した説明

アプリ説明・privacy policyでは以下を明記する。

* マイクを使う理由
* 音声がOpenAI APIに送信されること
* 翻訳結果がG2に表示されること
* 保存する/しないデータ
* backendドメイン
* ユーザーがいつでも停止できること

⸻

11. レイテンシ設計

11.1 目標値

指標	目標
first subtitle latency	1.0〜2.0秒以内
incremental subtitle update	250ms〜500ms間隔
first translated audio	2.0〜3.0秒以内
G2 display update interval	100〜250ms throttle
reconnect recovery	5秒以内

11.2 レイテンシ要因

* phone mic capture
* WebRTC connection establishment
* OpenAI server-side translation latency
* data channel event delivery
* subtitle buffering
* G2 Bluetooth bridge update
* textContainerUpgrade呼び出し頻度

11.3 対策

* delta受信ごとにG2更新しない。100〜250msでthrottleする。
* 長文historyをG2に流さない。
* status barと字幕本文を別containerに分ける。
* textContainerUpgradeを優先し、full rebuildを避ける。
* 通信切断時は即座にReconnecting...を表示する。

⸻

12. UI設計

12.1 画面一覧

Startup screen

G2 Translate
Press to start
Swipe: language

Permission screen

Allow mic on phone
to start translation.

Connecting screen

Connecting...
EN → JA

Live subtitle screen

EN→JA  LIVE ●  00:42
連携の前提として、既存の
入退室管理システムとの接続を
確認したいです。
Press pause / Swipe lang

Paused screen

Paused
Press to resume
Double press to exit

Error screen

Connection failed
Check phone app
Press retry

12.2 Phone companion UI

Phone側には最低限の設定UIを持つ。

* Start / Stop
* input source: phone mic / G2 mic / auto
* target language
* translated audio volume
* original audio mute
* debug logs
* current connection status
* privacy notice

12.3 表示更新ルール

* 字幕本文は短くする。
* session.output_transcript.delta を受信しても、毎回即G2に出さない。
* 意味単位または一定時間単位で表示を更新する。
* G2画面には「最新の意味単位」を出し、履歴はphone側に表示する。

⸻

13. API設計

13.1 POST /api/openai/realtime/translation/session

目的: WebViewがOpenAI Translation WebRTC sessionに接続するための短命client secretを取得する。

Request:

{
  "targetLanguage": "ja",
  "sourceHint": "auto",
  "userId": "even-user-id-or-anonymous",
  "client": {
    "appVersion": "0.1.0",
    "device": "G2"
  }
}

Response:

{
  "clientSecret": "...",
  "expiresAt": "2026-05-08T12:34:56Z",
  "model": "gpt-realtime-translate"
}

Error:

{
  "error": {
    "code": "rate_limited",
    "message": "Too many sessions. Please try again later."
  }
}

13.2 POST /api/events

PoC初期は任意。

用途:

* session start/end
* error telemetry
* latency metrics
* app lifecycle events

本文ログは送らない。

⸻

14. OpenAI Realtime Translation連携

14.1 Phase 1: WebRTC

1. WebView → backend: client secret request
2. backend → OpenAI: create translation client secret
3. backend → WebView: client secret
4. WebView: getUserMedia({ audio: true })
5. WebView: create RTCPeerConnection
6. WebView: add mic track
7. WebView: create data channel `oai-events`
8. WebView → OpenAI: POST SDP offer to translation calls endpoint
9. OpenAI → WebView: SDP answer
10. WebView: receive translated audio track
11. WebView: receive transcript delta events
12. WebView → G2: update subtitle container

14.2 Phase 2: WebSocket

1. G2 mic audioControl(true)
2. audioEvent receives PCM 16kHz mono
3. WASM worker resamples to 24kHz PCM16
4. WebView/backend sends session.input_audio_buffer.append
5. OpenAI returns session.output_transcript.delta
6. backend/WebView updates G2 subtitle
7. optional output audio is played on phone

14.3 Translation sessionの注意

* Translation sessionはvoice agentではなくinterpreterとして使う。
* response.createを呼ぶ通常Realtime sessionとは異なる。
* tool callや会話制御をしたい場合は、翻訳transcriptを別のLLM処理に分岐する。
* 会話型翻訳では話者トラックを混ぜない方がよい。
* PoCでは単一音声入力・単一出力言語から始める。

⸻

15. 実装詳細

15.1 起動処理

async function boot() {
  const bridge = await waitForEvenAppBridge()
  const settings = await loadSettings(bridge)
  await renderStartupScreen(bridge, settings)
  bridge.onEvenHubEvent(event => {
    dispatch(mapEvenEvent(event))
  })
}

15.2 翻訳開始

async function startTranslation(state: AppState) {
  setStatus('connecting')
  await renderConnectingScreen()
  const session = await api.createTranslationSession({
    targetLanguage: state.targetLanguage
  })
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const client = await createWebRtcTranslationClient({
    clientSecret: session.clientSecret,
    sourceStream: stream,
    onOutputTranscriptDelta: delta => subtitleBuffer.append(delta),
    onInputTranscriptDelta: delta => diagnostics.addSource(delta),
    onRemoteAudioTrack: track => audioPlayer.play(track),
    onStateChange: status => setConnectionStatus(status)
  })
  setStatus('live')
}

15.3 字幕更新

const subtitleBuffer = new SubtitleBuffer({
  maxChars: 180,
  updateIntervalMs: 150,
  onRender: async text => {
    const content = formatHudText({
      languagePair: state.languagePair,
      status: state.status,
      elapsed: state.elapsed,
      subtitle: text
    })
    await bridge.textContainerUpgrade(
      MAIN_CONTAINER_ID,
      'subtitle',
      content,
      0,
      content.length
    )
  }
})

15.4 終了処理

async function shutdown() {
  setStatus('exiting')
  await stopTranslationClient()
  await stopMicTracks()
  await saveSettings()
  await bridge.shutDownPageContainer(1)
}

⸻

16. テスト計画

16.1 単体テスト

* subtitleBuffer
* text layout
* language selector
* state reducer
* backend API client
* error mapping

16.2 WebView/ブラウザテスト

* mic permission
* WebRTC connection
* data channel events
* remote audio playback
* network/CORS
* reconnect behavior

16.3 Even Simulatorテスト

* startup screen
* live subtitle screen
* pause screen
* error screen
* long text overflow
* swipe/double pressのイベント処理

16.4 実機テスト

* G2表示の読みやすさ
* textContainerUpgradeのちらつき
* Bluetooth bridge遅延
* phone lock時の挙動
* Even Realities App background時の挙動
* double press exit
* QR sideload
* private build

16.5 翻訳品質テスト

評価観点:

* 日英会話
* 英日会話
* 固有名詞
* 数字
* 日付
* 金額
* 会社名/製品名
* 技術用語
* 騒音環境
* 早口
* 複数人発話
* code-switching

テスト文例:

We are considering integration with your existing access control system.
Could you explain your pricing model and expected deployment timeline?
The pilot starts on June 15th and the budget is around 3 million yen.
Akerun supports cloud-based access management for offices and facilities.

⸻

17. 評価指標

17.1 技術指標

指標	測定方法	合格ライン
起動成功率	20回起動	95%以上
WebRTC接続成功率	20回接続	90%以上
first subtitle latency	手動/ログ	2秒以内
G2表示更新安定性	実機観察	明確なちらつきなし
reconnection成功率	通信断テスト	80%以上
double press exit	実機操作	100%

17.2 UX指標

指標	合格ライン
字幕が読める	5段階評価で4以上
視線移動が少ない	スマホを見る頻度が明確に減る
操作が覚えやすい	1分以内に説明可能
商談中に邪魔にならない	主観評価4以上

17.3 事業/デモ指標

* 「スマートグラス上のAI字幕」として一目で伝わるか
* Even G2を買う理由として説得力があるか
* Akerun/Physical AI/現場支援に接続できるか
* PoCから社内デモ資料に展開できるか

⸻

18. リスクと対策

リスク	影響	対策
WebViewでWebRTCが不安定	Phase 1が詰まる	通常ブラウザPWA版を先に作り、Even WebView差分を切り分ける
OpenAI API key漏洩	重大	browserには短命client secretのみ渡す
CORS/whitelist問題	実機で通信不能	backend domainを明確化し、preflight含めてテストする
G2表示が読みにくい	UX低下	文字数を絞る。履歴はphoneに逃がす
翻訳遅延が大きい	体験低下	delta表示、早期字幕、音声出力は補助扱い
G2マイク品質が不足	Phase 2影響	Phase 1はphone micで開始。G2 micは比較対象にする
周囲音を拾いすぎる	品質低下	VAD、push-to-talk、phone mic/G2 mic選択
審査でpermission説明不足	公開遅延	privacy policyと初回説明を明確化
会話内容の扱いがセンシティブ	導入困難	保存しないデフォルト、明示opt-in、PIIログ禁止

⸻

19. 実装マイルストーン

Milestone 0: 技術スパイク

成果物:

* 通常ブラウザでOpenAI Realtime Translation WebRTCを動かす
* phone mic → translated audio + transcript deltaを確認
* backend client secret発行API

完了条件:

* Mac/Chromeで翻訳字幕が表示できる
* API keyがbrowserに露出しない

Milestone 1: Even Hub minimal app

成果物:

* Even Hub app skeleton
* G2 startup screen
* input events
* local storage
* QR sideload

完了条件:

* G2またはsimulator上で起動/終了できる
* single/double/swipeイベントが取れる

Milestone 2: G2 subtitle HUD

成果物:

* subtitleBuffer
* G2 display renderer
* live subtitle screen
* pause/resume

完了条件:

* OpenAI transcript deltaをG2に表示できる
* ちらつきが許容範囲

Milestone 3: 実機PoC

成果物:

* .ehpk package
* private build
* 実機テストログ
* latency計測
* UX評価

完了条件:

* 対面会話で英日/日英の字幕翻訳デモができる
* double pressで正常終了できる
* 主要エラー時にG2/phoneに状態表示できる

Milestone 4: Phase 2 spike

成果物:

* G2 microphone capture
* audioEvent取得
* WASM resampling prototype
* WebSocket translation gateway

完了条件:

* G2 mic音声をOpenAI WebSocket translationに流し、字幕を得られる
* phone mic版との品質・遅延比較ができる

⸻

20. Repository構成案

g2-realtime-translation-hud/
  apps/
    evenhub-app/
      app.json
      index.html
      package.json
      vite.config.ts
      tsconfig.json
      src/
        main.ts
        config.ts
        even/
        realtime/
        hud/
        audio/
        state/
        backend/
        companion/
      public/
        assets/
    web-pwa/
      # Even Hubに依存しない検証用PWA。任意。
  packages/
    audio-wasm/
      # Phase 2 Rust/WASM audio pipeline
    shared/
      # language definitions, state types, formatting utilities
  services/
    translation-backend/
      package.json
      src/
        server.ts
        openai.ts
        cors.ts
        rateLimit.ts
        telemetry.ts
  docs/
    design.md
    test-plan.md
    privacy.md
    demo-script.md

⸻

21. Backend実装メモ

21.1 Node.js / Fastify案

import Fastify from 'fastify'
const app = Fastify()
app.post('/api/openai/realtime/translation/session', async (req, reply) => {
  const { targetLanguage = 'ja', userId = 'anonymous' } = req.body as any
  const response = await fetch('https://api.openai.com/v1/realtime/translations/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': hashUserId(userId)
    },
    body: JSON.stringify({
      session: {
        model: 'gpt-realtime-translate',
        audio: {
          output: { language: targetLanguage }
        }
      }
    })
  })
  const json = await response.json()
  if (!response.ok) {
    return reply.status(response.status).send(json)
  }
  return {
    clientSecret: json.value,
    model: 'gpt-realtime-translate'
  }
})

21.2 CORS

PoCでは以下を許可する。

* local dev origin
* Even WebView originが特定可能ならそれ
* private buildのorigin

WebView originを安定して特定できない場合は、PoC段階では限定的に Access-Control-Allow-Origin: * を使い、本番前に再検討する。

⸻

22. Even Hub packaging

22.1 開発

npm install
npm run dev

22.2 QR sideload

evenhub qr --url "http://<LAN_IP>:5173"

22.3 build

npm run build

22.4 pack

evenhub pack app.json dist -o g2-translate.ehpk -c

22.5 private build upload

Developer Portalへ .ehpk をアップロードして、実機で確認する。

⸻

23. PoCデモシナリオ

23.1 デモ1: 英語→日本語字幕

1. G2を装着
2. アプリ起動
3. EN → JA を選択
4. 英語で話す
5. G2に日本語字幕が出る
6. phoneから日本語音声が出る
7. pressでpause/resume
8. double pressで終了

23.2 デモ2: 商談支援の入口

1. 英語発話を翻訳
2. phone側にsource/target transcriptを表示
3. 別LLM処理でキーワード抽出
4. G2下部に KEY: API / price / pilot のように表示

23.3 デモ3: Akerun文脈への接続

翻訳の横に短い文脈情報を表示する。

EN→JA LIVE
既存の入退室管理との
連携方法を確認したいです。
CTX: Akerun API demo

⸻

24. 今後の発展案

24.1 G2 native-feeling translator

* G2 micを使う
* Head gestureで言語切替
* R1 ringでpush-to-talk
* phoneを取り出さずに操作

24.2 Meeting co-pilot HUD

* 翻訳
* 要約
* 論点抽出
* 質問候補
* TODO候補
* CRMメモ生成

24.3 Field worker HUD

* 作業手順
* 音声メモ
* 写真/QR/位置情報
* 入退室ログ
* 異常報告

24.4 Robot / Physical AI Lab demo

* G2を人間用HUDとして利用
* ロボット実験の手順や状態を表示
* Akerun equipped space accessのデモと接続
* 人間/ロボットが同じ空間OSを使うストーリーに接続

⸻

25. 最初に着手するタスク

1. OpenAI Realtime Translation WebRTCの最小ブラウザPoCを作る。
2. Backend client secret発行APIを作る。
3. Even Hub minimal appを作る。
4. G2に固定文言を表示し、入力イベントを取る。
5. OpenAI transcript deltaをG2字幕containerに流す。
6. textContainerUpgradeの更新頻度とちらつきを確認する。
7. .ehpkにpackし、実機private buildでテストする。
8. phone mic版のUX評価後、G2 mic版へ進む。

⸻

26. 判断ポイント

PoC後に判断すべきこと。

1. G2字幕は実用に足るか
    文字数、視認性、更新頻度、視界への干渉を評価する。
2. phone micで十分か、G2 micに進むべきか
    翻訳品質、装着体験、商談時の自然さで比較する。
3. 音声出力はphoneで許容されるか
    イヤホン/Bluetoothイヤホン併用も検討する。
4. 商談支援へ伸ばす価値があるか
    翻訳単体より、固有名詞・数字・次質問のHUDが刺さるかを確認する。
5. Akerun/Physical AI文脈に接続できるか
    現場作業・入退室・ロボット実験HUDとして差別化できるかを判断する。