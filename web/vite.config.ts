import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const serverPort = process.env.OYSTER_PORT ?? '4444'
const target = `http://localhost:${serverPort}`

export default defineConfig({
  plugins: [react()],
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
