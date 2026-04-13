import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7337,
    proxy: {
      '/api/chat/events': {
        target: 'http://localhost:4444',
        headers: { Accept: 'text/event-stream' },
      },
      '/api/ui/events': {
        target: 'http://localhost:4444',
        headers: { Accept: 'text/event-stream' },
      },
      '/api': 'http://localhost:4444',
      '/docs': 'http://localhost:4444',
      '/artifacts': 'http://localhost:4444',
    }
  }
})
