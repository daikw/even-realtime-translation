import Fastify, { type FastifyInstance } from 'fastify'

export interface BuildServerOptions {
  logger?: boolean
}

// Bare scaffold. M2 (Task #3) replaces this with CORS, rate limit, OpenAI client secret route etc.
export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? true })

  app.get('/health', () => ({ status: 'ok' }))

  return app
}
