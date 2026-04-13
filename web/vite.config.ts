import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const serverPort = process.env.OYSTER_PORT ?? '4444'
const target = `http://localhost:${serverPort}`
const pkg = JSON.parse(readFileSync('../package.json', 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_ENV__: JSON.stringify(process.env.NODE_ENV === 'production' ? 'prod' : 'dev'),
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
      '/docs': target,
      '/artifacts': target,
    }
  }
})
