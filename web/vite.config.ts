import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/chat/events': {
        target: 'http://localhost:4200',
        headers: { Accept: 'text/event-stream' },
      },
      '/api': 'http://localhost:4200',
      '/docs': 'http://localhost:4200',
      '/artefacts': 'http://localhost:4200',
    }
  }
})
