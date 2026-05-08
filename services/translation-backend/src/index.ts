import 'dotenv/config'
import { loadConfig } from './config.js'
import { buildServer } from './server.js'

const config = loadConfig()
const app = buildServer({ config })

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((addr) => {
    app.log.info(`backend listening on ${addr}`)
  })
  .catch((err: unknown) => {
    app.log.error(err)
    process.exit(1)
  })
