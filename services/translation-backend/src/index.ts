import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from './config.js'
import { buildServer } from './server.js'

// Load `.env` from the workspace root (../../.. relative to this file at
// services/translation-backend/src/index.ts) so the same single source of
// truth feeds both the backend and any future colocated tools, regardless of
// the cwd from which `pnpm --filter` was invoked.
const here = path.dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: path.resolve(here, '../../../.env') })
// Fall back to a local `.env` inside the service directory if someone keeps
// per-service secrets there; `override: false` means the workspace-root file
// already loaded above wins on key conflict.
loadDotenv({ path: path.resolve(here, '../.env'), override: false })

const config = loadConfig()
const app = buildServer({ config })

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => {
    app.log.info(`backend listening on ${addr}`)
  })
  .catch((err: unknown) => {
    app.log.error(err)
    process.exit(1)
  })
