import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Dev handshake: the server writes its actual bound port to userland/.dev-port
// after listen(). Reading it here means each worktree's vite always proxies to
// its own backend, even with multiple Oysters running on auto-bumped ports.
// Falls back to OYSTER_PORT (explicit override) then 3333 (cold-start default).
function resolveServerPort(): string {
  const portFile = resolve(__dirname, '..', 'userland', '.dev-port')
  if (existsSync(portFile)) {
    const v = readFileSync(portFile, 'utf8').trim()
    if (/^\d+$/.test(v)) return v
  }
  return process.env.OYSTER_PORT ?? '3333'
}
const serverPort = resolveServerPort()
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
