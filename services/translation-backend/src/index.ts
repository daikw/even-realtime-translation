import 'dotenv/config'
import { buildServer } from './server.js'

const port = Number(process.env.BACKEND_PORT ?? 3000)

const app = buildServer()

app
  .listen({ port, host: '0.0.0.0' })
  .then((addr) => {
    app.log.info(`backend listening on ${addr}`)
  })
  .catch((err: unknown) => {
    app.log.error(err)
    process.exit(1)
  })
