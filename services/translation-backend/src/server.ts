import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { SUPPORTED_LANGUAGES, type LanguageCode } from '@even-rt/shared'
import { computeSafetyIdentifier } from '@even-rt/shared/server'
import { type Config } from './config.js'
import {
  TRANSLATION_MODEL,
  UpstreamError,
  mapUpstreamError,
  requestClientSecret,
} from './openai.js'
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
  /** Optional fetch override for unit tests. */
  fetchImpl?: typeof fetch
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

interface SessionRequestBody {
  targetLanguage?: unknown
  sourceHint?: unknown
  userId?: unknown
  client?: { appVersion?: unknown; device?: unknown }
}

interface SessionRouteSchema {
  Body: SessionRequestBody
}

const ANONYMOUS_USER_ID = 'anonymous'
const MAX_USER_ID_LENGTH = 256
const MAX_CLIENT_FIELD_LENGTH = 64

// `auto` is a valid source hint but not a valid output target; the model needs
// a concrete language to render reliably on the G2.
const TARGET_LANGUAGES = SUPPORTED_LANGUAGES.filter(
  (code): code is Exclude<LanguageCode, 'auto'> => code !== 'auto',
)
const SOURCE_HINTS = SUPPORTED_LANGUAGES

function badRequest(message: string): { status: 400; body: { error: { code: string; message: string } } } {
  return {
    status: 400,
    body: { error: { code: 'invalid_request', message } },
  }
}

function readStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { statusCode?: unknown }).statusCode
  return typeof code === 'number' ? code : undefined
}

interface ValidatedSession {
  targetLanguage: Exclude<LanguageCode, 'auto'>
  userId: string
}

function validateSessionBody(body: SessionRequestBody): ValidatedSession | { error: string } {
  const { targetLanguage, sourceHint, userId, client } = body

  if (typeof targetLanguage !== 'string') {
    return { error: 'targetLanguage is required' }
  }
  if (!(TARGET_LANGUAGES as readonly string[]).includes(targetLanguage)) {
    return { error: `targetLanguage must be one of ${TARGET_LANGUAGES.join(', ')}` }
  }

  if (sourceHint !== undefined) {
    if (typeof sourceHint !== 'string' || !(SOURCE_HINTS as readonly string[]).includes(sourceHint)) {
      return { error: `sourceHint must be one of ${SOURCE_HINTS.join(', ')}` }
    }
  }

  let resolvedUserId = ANONYMOUS_USER_ID
  if (userId !== undefined) {
    if (typeof userId !== 'string') return { error: 'userId must be a string' }
    if (userId.length === 0) return { error: 'userId must not be empty' }
    if (userId.length > MAX_USER_ID_LENGTH) {
      return { error: `userId must be ${String(MAX_USER_ID_LENGTH)} characters or fewer` }
    }
    resolvedUserId = userId
  }

  if (client !== undefined) {
    if (typeof client !== 'object' || client === null) {
      return { error: 'client must be an object' }
    }
    const { appVersion, device } = client
    if (appVersion !== undefined) {
      if (typeof appVersion !== 'string' || appVersion.length === 0) {
        return { error: 'client.appVersion must be a non-empty string' }
      }
      if (appVersion.length > MAX_CLIENT_FIELD_LENGTH) {
        return {
          error: `client.appVersion must be ${String(MAX_CLIENT_FIELD_LENGTH)} characters or fewer`,
        }
      }
    }
    if (device !== undefined) {
      if (typeof device !== 'string' || device.length === 0) {
        return { error: 'client.device must be a non-empty string' }
      }
      if (device.length > MAX_CLIENT_FIELD_LENGTH) {
        return {
          error: `client.device must be ${String(MAX_CLIENT_FIELD_LENGTH)} characters or fewer`,
        }
      }
    }
  }

  return { targetLanguage: targetLanguage as Exclude<LanguageCode, 'auto'>, userId: resolvedUserId }
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const config = opts.config
  if (!config) {
    throw new Error('buildServer requires a Config instance')
  }
  const fetchImpl = opts.fetchImpl ?? fetch

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
    // We do manual validation in the route handler, so this branch only fires
    // for fastify-internal errors (rate-limit 429, malformed JSON 400 from
    // body parser, unhandled exceptions).
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

    instance.post<SessionRouteSchema>(
      '/api/openai/realtime/translation/session',
      {
        config: {
          rateLimit: {
            max: 20,
            timeWindow: '1 minute',
          },
        },
      },
      async (req: FastifyRequest<SessionRouteSchema>, reply) => {
        const validated = validateSessionBody(req.body ?? {})
        if ('error' in validated) {
          const r = badRequest(validated.error)
          void reply.status(r.status).send(r.body)
          return
        }

        const safetyId = await computeSafetyIdentifier(config.safetyIdSalt, validated.userId)

        try {
          const secret = await requestClientSecret({
            apiKey: config.openaiApiKey,
            safetyId,
            targetLanguage: validated.targetLanguage,
            fetchImpl,
          })
          return {
            clientSecret: secret.clientSecret,
            ...(secret.expiresAt !== undefined ? { expiresAt: secret.expiresAt } : {}),
            model: TRANSLATION_MODEL,
          }
        } catch (err) {
          if (err instanceof UpstreamError) {
            const mapped = mapUpstreamError(err.status)
            // Log only the upstream status and our internal code — never the
            // upstream body or our API key.
            req.log.warn(
              { upstreamStatus: err.status, code: mapped.code },
              'OpenAI client_secrets request failed',
            )
            void reply.status(mapped.status).send({
              error: { code: mapped.code, message: mapped.message },
            })
            return
          }
          // Network error or unexpected upstream shape.
          req.log.warn({ err: (err as Error).name }, 'OpenAI fetch failed')
          void reply.status(502).send({
            error: { code: 'upstream_error', message: 'Translation service unavailable' },
          })
          return
        }
      },
    )

    instance.post('/api/events', async (_req, reply) => {
      // PoC stub: accept the body so the client doesn't error, but discard it.
      // Per §10.2 we do not persist or log telemetry payloads.
      await reply.code(204).send()
    })

    done()
  })

  return app
}
