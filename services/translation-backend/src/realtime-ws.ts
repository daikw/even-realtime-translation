/**
 * Frontend ↔ backend ↔ OpenAI WebSocket relay for the Phase 2 audio path.
 *
 * See `docs/phase2-migration-plan.md` §2.1 / §3 T2.2 / §10.3. The relay is
 * the heart of Phase 2 — it owns the upstream connection, normalises errors,
 * and enforces guard-rails (origin allowlist, per-IP cap, grace period,
 * idle timeout, downstream back-pressure).
 *
 * Why event names look duplicated: the *internal* protocol (`audio`, `close`,
 * `language`) is intentionally short and human-readable, while the
 * *upstream* OpenAI protocol prefixes every client→server event with
 * `session.` (T0.1 finding §10.3). The relay is the only place that ever
 * needs to translate between the two.
 */

import websocket from '@fastify/websocket'
import { WebSocket as WsClient, type RawData, type WebSocket as WsSocket } from 'ws'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

import {
  SUPPORTED_LANGUAGES,
  type ClientWsMessage,
  type LanguageCode,
  type ServerWsMessage,
} from '@even-rt/shared'
import { computeSafetyIdentifier } from '@even-rt/shared/server'

import { type Config } from './config.js'
import { TRANSLATION_MODEL } from './openai.js'

export const REALTIME_WS_PATH = '/api/realtime/ws'
export const UPSTREAM_URL = `wss://api.openai.com/v1/realtime/translations?model=${TRANSLATION_MODEL}`
export const TRANSCRIPTION_MODEL = 'gpt-realtime-whisper'
export const NOISE_REDUCTION_TYPE = 'near_field' as const

/** Time after a graceful `session.close` before tearing down the upstream WS.
 * T0.1 observed trailing transcript / audio deltas up to ~6 s after the
 * client's last audio chunk; 6 s gives the upstream room to drain. */
export const GRACE_PERIOD_MS = 6000

/** Hard idle timeout — bumped on every client message and upstream event. */
export const IDLE_TIMEOUT_MS = 30_000

/** 64 KB per frame caps a single audio chunk (≈100 ms = ~13 KB base64) plus
 * upstream JSON envelope. Anything larger is almost certainly a misbehaving
 * client. */
export const MAX_PAYLOAD_BYTES = 64 * 1024

/** Allow 2 concurrent sessions per source IP (handles iOS reconnect race).
 *
 * NOTE on proxy deployments (Codex review M-5, PR #10): when this service
 * runs behind a reverse proxy (Cloud Run / Nginx / Tailscale Serve), every
 * client will share the proxy's source IP and 2 concurrent users will
 * starve the third. To use this cap as intended, set Fastify's `trustProxy`
 * to the proxy's IP/CIDR in `buildServer` and rely on `req.ip` resolving
 * via X-Forwarded-For. Without that change, treat this cap as a *node-level*
 * burst limit rather than a per-user gate. */
export const MAX_CONNECTIONS_PER_IP = 2

/** If the *client* socket falls behind by >1 MB of buffered audio frames the
 * client cannot keep up; drop the session rather than burn server memory. */
export const CLIENT_BUFFER_LIMIT_BYTES = 1024 * 1024

type TargetLanguage = Exclude<LanguageCode, 'auto'>

const TARGET_LANGUAGES = SUPPORTED_LANGUAGES.filter((c): c is TargetLanguage => c !== 'auto')

// ──────────────────────────────────────────────────────────────────────────
// Public API.
// ──────────────────────────────────────────────────────────────────────────

export interface RegisterRealtimeWsOptions {
  config: Config
  /** Inject for tests; defaults to the real `ws` WebSocket client. */
  WsImpl?: typeof WsClient
  /** Override upstream URL for tests (e.g. an in-process mock at 127.0.0.1:0). */
  upstreamUrl?: string
  /** Derive a userId for safety-id hashing. Default: query string `userId` or `'anonymous'`. */
  resolveUserId?: (req: FastifyRequest) => string
  /** Override grace period for tests. */
  gracePeriodMs?: number
  /** Override idle timeout for tests. */
  idleTimeoutMs?: number
}

export function registerRealtimeWs(
  app: FastifyInstance,
  opts: RegisterRealtimeWsOptions,
): void {
  // Register the websocket support plugin first; Fastify queues plugin loads
  // in registration order, so any route plugin registered after this will see
  // the `websocket: true` route shorthand even though loads happen async.
  void app.register(websocket, {
    options: { maxPayload: MAX_PAYLOAD_BYTES },
  })

  // Per-IP in-memory counter. Map is fine — typical concurrent connection
  // count is in the single digits; this is not a distributed system.
  const ipCounter = new Map<string, number>()

  const resolveUserId =
    opts.resolveUserId ??
    ((req): string => {
      const q = (req.query as { userId?: unknown } | undefined)?.userId
      return typeof q === 'string' && q.length > 0 && q.length <= 256 ? q : 'anonymous'
    })

  // Register the route inside an encapsulated plugin so it inherits the
  // (preValidation, errorHandler) decorators from the surrounding app while
  // staying isolated from any per-route hooks the legacy HTTP routes add.
  void app.register((instance, _opts, done) => {
    instance.get(
      REALTIME_WS_PATH,
      {
        websocket: true,
        preValidation: async (req, reply): Promise<void> => {
          const origin = req.headers.origin
          if (typeof origin !== 'string' || !opts.config.allowedOrigins.includes(origin)) {
            req.log.warn({ origin }, 'WS upgrade rejected: origin not allowed')
            await reply.code(403).send({
              error: { code: 'forbidden', message: 'Origin not allowed' },
            })
            return
          }
          const count = ipCounter.get(req.ip) ?? 0
          if (count >= MAX_CONNECTIONS_PER_IP) {
            req.log.warn({ ip: req.ip, count }, 'WS upgrade rejected: per-IP limit')
            await reply.code(429).send({
              error: {
                code: 'too_many_connections',
                message: 'Connection limit per IP exceeded',
              },
            })
            return
          }
        },
      },
      (socket, req) => {
        ipCounter.set(req.ip, (ipCounter.get(req.ip) ?? 0) + 1)
        const release = (): void => {
          const after = (ipCounter.get(req.ip) ?? 1) - 1
          if (after <= 0) ipCounter.delete(req.ip)
          else ipCounter.set(req.ip, after)
        }

        runRelay({
          socket,
          req,
          config: opts.config,
          upstreamUrl: opts.upstreamUrl ?? UPSTREAM_URL,
          WsImpl: opts.WsImpl ?? WsClient,
          resolveUserId,
          gracePeriodMs: opts.gracePeriodMs ?? GRACE_PERIOD_MS,
          idleTimeoutMs: opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
          onClose: release,
        })
      },
    )
    done()
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Per-connection relay state machine.
// ──────────────────────────────────────────────────────────────────────────

type RelayState = 'awaiting_open' | 'connecting_upstream' | 'live' | 'closing' | 'closed'

interface RunRelayDeps {
  socket: WsSocket
  req: FastifyRequest
  config: Config
  upstreamUrl: string
  WsImpl: typeof WsClient
  resolveUserId: (req: FastifyRequest) => string
  gracePeriodMs: number
  idleTimeoutMs: number
  onClose: () => void
}

function runRelay(deps: RunRelayDeps): void {
  const { socket, req, config, upstreamUrl, WsImpl, resolveUserId } = deps
  const log = req.log

  let state: RelayState = 'awaiting_open'
  let upstream: WsSocket | null = null
  let upstreamMetaEmitted = false
  let targetLanguage: TargetLanguage | null = null
  let userId = ''
  let safetyId = ''
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  // Idle timer: any client message, upstream event, or client pong resets
  // it. Default 30 s; ample for translation (audio chunks arrive ~every
  // 100 ms in active use). Codex review M-1 (PR #10): periodically ping the
  // client so a silent-but-alive client (e.g. mid-network-blip) doesn't
  // get killed by the idle gate — `socket.on('pong')` then bumps idle.
  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    log.warn('WS idle timeout — closing')
    sendDownstream({ type: 'error', code: 'idle_timeout', message: 'Connection idle timeout' })
    teardown('idle_timeout')
  }, deps.idleTimeoutMs)
  const bumpIdle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      log.warn('WS idle timeout — closing')
      sendDownstream({ type: 'error', code: 'idle_timeout', message: 'Connection idle timeout' })
      teardown('idle_timeout')
    }, deps.idleTimeoutMs)
  }
  // Ping the client at half the idle interval so a healthy-but-quiet session
  // (e.g. user paused) survives. ws auto-responds to inbound server pings on
  // the browser side, and Node's `WebSocket` emits 'pong' on this socket.
  const pingInterval = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return
    try {
      socket.ping()
    } catch {
      /* ignore — socket may have died between the readyState read and the ping */
    }
  }, Math.max(deps.idleTimeoutMs / 2, 1000))
  socket.on('pong', () => {
    bumpIdle()
  })

  // ── downstream helpers ──────────────────────────────────────────────────
  function sendDownstream(msg: ServerWsMessage): void {
    if (socket.readyState !== socket.OPEN) return
    if (socket.bufferedAmount > CLIENT_BUFFER_LIMIT_BYTES) {
      // Tear down both legs immediately so we stop billing upstream tokens
      // for a client that cannot drain them. Closing the client socket only
      // would leave the upstream alive until the client's `close` event
      // bubbles back. Codex review H-3 (PR #10).
      log.warn({ buffered: socket.bufferedAmount }, 'client back-pressure exceeded — tearing down')
      teardown('back_pressure')
      return
    }
    try {
      socket.send(JSON.stringify(msg))
    } catch (err) {
      log.warn({ err: (err as Error).name }, 'sendDownstream failed')
    }
  }

  function teardown(reason: string): void {
    if (state === 'closed') return
    state = 'closed'
    clearTimeout(idleTimer)
    clearInterval(pingInterval)
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    try {
      if (upstream && upstream.readyState !== upstream.CLOSED) {
        upstream.close(1000, reason)
      }
    } catch {
      /* swallow */
    }
    try {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close(1000, reason)
      }
    } catch {
      /* swallow */
    }
    deps.onClose()
  }

  // ── upstream wiring ─────────────────────────────────────────────────────
  function connectUpstream(target: TargetLanguage): void {
    state = 'connecting_upstream'
    log.info({ targetLanguage: target, upstreamUrl }, 'connecting upstream')
    const u = new WsImpl(upstreamUrl, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'OpenAI-Safety-Identifier': safetyId,
      },
      // Match maxPayload to the downstream cap so we never accept a frame the
      // client could never send back. (Upstream audio.delta is ~19 KB so this
      // is comfortable.)
      maxPayload: MAX_PAYLOAD_BYTES,
    })
    upstream = u

    u.on('open', () => {
      log.info('upstream open')
      // Send session.update immediately; per T0.1 we may then send audio
      // chunks without waiting for session.updated.
      const payload = {
        type: 'session.update',
        session: {
          audio: {
            input: {
              transcription: { model: TRANSCRIPTION_MODEL },
              noise_reduction: { type: NOISE_REDUCTION_TYPE },
            },
            output: { language: target },
          },
        },
      }
      try {
        u.send(JSON.stringify(payload))
        state = 'live'
        bumpIdle()
      } catch (err) {
        log.warn({ err: (err as Error).name }, 'upstream session.update send failed')
        sendDownstream({
          type: 'error',
          code: 'upstream_error',
          message: 'Translation service unavailable',
        })
        teardown('upstream_send_failed')
      }
    })

    u.on('message', (raw: RawData) => {
      bumpIdle()
      const parsed = safeJson(raw)
      if (parsed === null || typeof parsed !== 'object') {
        log.warn('upstream message was not JSON; ignoring')
        return
      }
      handleUpstreamEvent(parsed as Record<string, unknown>)
    })

    u.on('error', (err: Error) => {
      // Intentionally log only the error class name. Upstream `err.message`
      // can echo internal identifiers / token state and must not be retained
      // in log archives. Codex review H-2 (PR #10).
      log.warn({ err: err.name }, 'upstream error')
      sendDownstream({
        type: 'error',
        code: 'upstream_error',
        message: 'Translation service unavailable',
      })
      teardown('upstream_error')
    })

    u.on('close', (code: number) => {
      // Same sanitisation: keep only the WS close code, drop the reason
      // string. Codex review H-2 (PR #10).
      log.info({ code }, 'upstream closed')
      if (state !== 'closing' && state !== 'closed') {
        sendDownstream({
          type: 'error',
          code: 'upstream_closed',
          message: 'Translation service connection closed',
        })
      }
      teardown('upstream_closed')
    })
  }

  function handleUpstreamEvent(ev: Record<string, unknown>): void {
    const type = typeof ev.type === 'string' ? ev.type : ''
    switch (type) {
      case 'session.created':
      case 'session.updated': {
        // Emit `session.created` to the client only once — whichever event
        // arrives first (typically session.created). Subsequent updates are
        // informational and would just churn the client UI.
        if (upstreamMetaEmitted) return
        upstreamMetaEmitted = true
        const session = ev.session as Record<string, unknown> | undefined
        const upstreamSessionId =
          session && typeof session.id === 'string' ? session.id : undefined
        sendDownstream({
          type: 'session.created',
          meta: {
            ...(upstreamSessionId !== undefined ? { upstreamSessionId } : {}),
            model: TRANSLATION_MODEL,
            targetLanguage: targetLanguage ?? 'en',
          },
        })
        return
      }
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        const delta = typeof ev.delta === 'string' ? ev.delta : ''
        if (delta.length === 0) return
        const itemId = typeof ev.item_id === 'string' ? ev.item_id : undefined
        sendDownstream({
          type: 'transcript.delta',
          source: type === 'session.input_transcript.delta' ? 'input' : 'output',
          text: delta,
          ...(itemId !== undefined ? { itemId } : {}),
        })
        return
      }
      case 'session.output_audio.delta': {
        const pcm = typeof ev.delta === 'string' ? ev.delta : ''
        if (pcm.length === 0) return
        sendDownstream({ type: 'audio.delta', pcm })
        return
      }
      case 'error': {
        const err = (ev.error as Record<string, unknown> | undefined) ?? {}
        const upstreamCode = typeof err.code === 'string' ? err.code : ''
        const upstreamType = typeof err.type === 'string' ? err.type : ''
        // Sanitise — never propagate upstream message verbatim (PII risk per
        // existing openai.ts pattern). Categorise into our internal codes.
        if (upstreamType === 'invalid_request_error') {
          sendDownstream({
            type: 'error',
            code: 'invalid_request',
            message: 'Translation service rejected the request',
          })
        } else if (upstreamCode === 'rate_limit_exceeded') {
          sendDownstream({
            type: 'error',
            code: 'rate_limited',
            message: 'Too many requests',
          })
        } else {
          sendDownstream({
            type: 'error',
            code: 'upstream_error',
            message: 'Translation service unavailable',
          })
        }
        return
      }
      default:
        // Forward-compat: log unknown event types but don't error out.
        log.debug({ type }, 'unhandled upstream event')
    }
  }

  // ── client → relay ──────────────────────────────────────────────────────
  socket.on('message', (raw: RawData) => {
    bumpIdle()
    if (state === 'closing' || state === 'closed') return
    const parsed = parseClientMessage(safeJson(raw))
    if (parsed === null) {
      sendDownstream({
        type: 'error',
        code: 'invalid_request',
        message: 'Malformed or unsupported client message',
      })
      return
    }
    // `dispatchClient` is async only for `open` (await computeSafetyIdentifier).
    // Any rejection is converted to a sanitised downstream error + teardown so
    // a hashing failure cannot leak as an unhandled rejection that bypasses
    // ipCounter cleanup. Codex review B/H feedback (PR #10).
    void dispatchClient(parsed).catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.name : 'Unknown' },
        'client dispatch failed',
      )
      sendDownstream({
        type: 'error',
        code: 'upstream_error',
        message: 'Translation service unavailable',
      })
      teardown('dispatch_failed')
    })
  })

  async function dispatchClient(msg: ClientWsMessage): Promise<void> {
    switch (msg.type) {
      case 'open': {
        if (state !== 'awaiting_open') {
          sendDownstream({
            type: 'error',
            code: 'invalid_request',
            message: 'open already received',
          })
          return
        }
        // Lock state synchronously *before* the await — otherwise a concurrent
        // second `open` (or a `close` arriving while the hash is computing)
        // would slip past the `awaiting_open` check and create a duplicate
        // upstream connection. Codex review B-1 / B-2 (PR #10).
        state = 'connecting_upstream'
        // parseClientMessage already rejects 'auto', so the cast is safe.
        targetLanguage = msg.targetLanguage as TargetLanguage
        userId = resolveUserId(req)
        try {
          safetyId = await computeSafetyIdentifier(config.safetyIdSalt, userId)
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.name : 'Unknown' },
            'safety id computation failed',
          )
          sendDownstream({
            type: 'error',
            code: 'upstream_error',
            message: 'Translation service unavailable',
          })
          teardown('safety_id_failed')
          return
        }
        // If a `close` arrived while we were awaiting the hash, do not start
        // the upstream connection.
        if (state !== 'connecting_upstream') return
        connectUpstream(targetLanguage)
        return
      }

      case 'audio':
        if (state !== 'live' || !upstream || upstream.readyState !== upstream.OPEN) {
          // Drop pre-open audio — the alternative (buffer) keeps memory growing
          // if the client never sends `open`. Client is expected to wait for
          // session.created before streaming audio in normal usage.
          return
        }
        try {
          upstream.send(
            JSON.stringify({ type: 'session.input_audio_buffer.append', audio: msg.pcm }),
          )
        } catch (err) {
          log.warn({ err: (err as Error).name }, 'upstream audio forward failed')
        }
        return

      case 'language':
        if (state !== 'live' || !upstream || upstream.readyState !== upstream.OPEN) {
          sendDownstream({
            type: 'error',
            code: 'invalid_request',
            message: 'language change requires an active session',
          })
          return
        }
        targetLanguage = msg.target as TargetLanguage
        try {
          upstream.send(
            JSON.stringify({
              type: 'session.update',
              session: { audio: { output: { language: targetLanguage } } },
            }),
          )
        } catch (err) {
          log.warn({ err: (err as Error).name }, 'upstream language change failed')
        }
        return

      case 'close':
        if (state === 'closed' || state === 'closing') return
        state = 'closing'
        // Send session.close to upstream and hold both sockets open for the
        // grace period so trailing deltas can drain (T0.1 finding §10.3).
        if (upstream && upstream.readyState === upstream.OPEN) {
          try {
            upstream.send(JSON.stringify({ type: 'session.close' }))
          } catch {
            /* swallow */
          }
        }
        closeTimer = setTimeout(() => {
          teardown('graceful')
        }, deps.gracePeriodMs)
        return
    }
  }

  socket.on('close', (code: number) => {
    // Drop client-supplied close reason; cf. Codex review H-2 (PR #10).
    log.info({ code }, 'client socket closed')
    teardown('client_closed')
  })
  socket.on('error', (err: Error) => {
    log.warn({ err: err.name }, 'client socket error')
    teardown('client_error')
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Pure parsers / validators.
// ──────────────────────────────────────────────────────────────────────────

function safeJson(raw: RawData): unknown {
  // `RawData` is `Buffer | ArrayBuffer | Buffer[]`. Buffer's `.toString()` is
  // safe, but ArrayBuffer / Buffer[] would invoke `Object.prototype.toString`
  // and yield "[object …]" — handle each shape explicitly.
  let text: string
  if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf-8')
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString('utf-8')
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw).toString('utf-8')
  } else {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && (TARGET_LANGUAGES as readonly string[]).includes(value)
}

export function parseClientMessage(value: unknown): ClientWsMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  switch (obj.type) {
    case 'open':
      return isTargetLanguage(obj.targetLanguage)
        ? { type: 'open', targetLanguage: obj.targetLanguage }
        : null
    case 'audio':
      return typeof obj.pcm === 'string' && obj.pcm.length > 0
        ? { type: 'audio', pcm: obj.pcm }
        : null
    case 'language':
      return isTargetLanguage(obj.target) ? { type: 'language', target: obj.target } : null
    case 'close':
      return { type: 'close' }
    default:
      return null
  }
}

// Re-export for the legacy preValidation reply path (used implicitly).
export type { FastifyReply }
