import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPort = process.env.OYSTER_PORT ?? '3333'
const target = `http://localhost:${serverPort}`
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'))

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_ENV__: JSON.stringify(mode === 'production' ? 'prod' : 'dev'),
  },
  server: {
    port: 7337,
    proxy: {
      '/api/chat/events': {
        target,
        headers: { Accept: 'text/event-stream' },
      },
      '/api/ui/events': {
        target,
        headers: { Accept: 'text/event-stream' },
      },
      '/api': target,
      '/mcp': target,
      '/docs': target,
      '/artifacts': target,
      '/.well-known': target,
    }
  }
}))
