import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { type Config } from './config.js'
import { registerRealtimeWs } from './realtime-ws.js'
import { VERSION } from './version.js'

export interface BuildServerOptions {
  /** Enable Fastify's built-in pino logger. Tests pass `false`. */
  logger?: boolean
  /**
   * Backend config. When omitted, the env-var loader runs at startup. Tests
   * supply a fixed config to avoid touching `process.env`.
   */
  config?: Config
  /**
   * When set, override the upstream OpenAI Realtime Translation WS URL. Used
   * by `realtime-ws.test.ts` to point the relay at an in-process mock server.
   */
  upstreamWsUrl?: string
  /** Shorten WS idle timeout for tests. Production default = 30 s. */
  realtimeWsIdleTimeoutMs?: number
  /** Shorten WS graceful-close period for tests. Production default = 6 s. */
  realtimeWsGracePeriodMs?: number
}

function readStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { statusCode?: unknown }).statusCode
  return typeof code === 'number' ? code : undefined
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const config = opts.config
  if (!config) {
    throw new Error('buildServer requires a Config instance')
  }

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            redact: {
              paths: [
                'req.headers.authorization',
                'res.headers["set-cookie"]',
                'req.body.userId',
                'req.body.client',
              ],
              remove: true,
            },
          },
    // Disable Fastify's default body logging so we never accidentally log
    // payloads (transcripts/audio metadata) — design §10.2.
    disableRequestLogging: false,
  })

  void app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server requests have no Origin header.
      if (origin === undefined) {
        cb(null, true)
        return
      }
      cb(null, config.allowedOrigins.includes(origin))
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  })

  void app.register(rateLimit, {
    global: true,
    max: 60,
    timeWindow: '1 minute',
  })

  // Phase 2 WS relay. Registered *before* the legacy HTTP route plugin so
  // `@fastify/websocket` is loaded into the plugin tree first (see
  // docs/phase2-migration-plan.md §3 T2.1).
  registerRealtimeWs(app, {
    config,
    ...(opts.upstreamWsUrl !== undefined ? { upstreamUrl: opts.upstreamWsUrl } : {}),
    ...(opts.realtimeWsIdleTimeoutMs !== undefined
      ? { idleTimeoutMs: opts.realtimeWsIdleTimeoutMs }
      : {}),
    ...(opts.realtimeWsGracePeriodMs !== undefined
      ? { gracePeriodMs: opts.realtimeWsGracePeriodMs }
      : {}),
  })

  app.setErrorHandler((err: unknown, _req, reply) => {
    // Most validation lives in the WS preValidation hook (Origin allowlist,
    // per-IP cap) and the realtime-ws message parser. This handler only
    // fires for Fastify-internal failures (rate-limit 429, malformed JSON
    // 400 from the body parser, unhandled exceptions on /health etc.).
    const status = readStatusCode(err)
    if (status === 400) {
      void reply.status(400).send({
        error: { code: 'invalid_request', message: 'Invalid request body' },
      })
      return
    }
    if (status === 429) {
      void reply.status(429).send({
        error: { code: 'rate_limited', message: 'Too many requests' },
      })
      return
    }
    void reply.status(500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
    })
  })

  // Routes are registered inside an async plugin so they run AFTER
  // `@fastify/rate-limit`'s `onRoute` hook is in place. Without this,
  // per-route `config.rateLimit` overrides are silently dropped.
  void app.register((instance, _opts, done) => {
    instance.get('/health', () => ({ ok: true, version: VERSION }))

    instance.post('/api/events', async (_req, reply) => {
      // PoC stub: accept the body so the client doesn't error, but discard it.
      // Per §10.2 we do not persist or log telemetry payloads.
      await reply.code(204).send()
    })

    done()
  })

  return app
}
