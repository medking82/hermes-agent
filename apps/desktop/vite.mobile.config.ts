import type { ClientRequest, IncomingMessage } from 'node:http'
import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// Development proxy only. Production serves this bundle under the EXISTING authenticated
// dashboard origin. Never expose Vite or the backend by changing this bind to 0.0.0.0.
const backend = 'http://127.0.0.1:9119'

const proxy: ProxyOptions = {
  target: backend,
  changeOrigin: true,
  ws: true,
  configure(server) {
    const rewriteOwnOrigin = (outgoing: ClientRequest, request: IncomingMessage) => {
      if (request.headers.origin === `http://${request.headers.host}`) {
        outgoing.setHeader('Origin', backend)
      }
    }

    server.on('proxyReq', rewriteOwnOrigin)
    server.on('proxyReqWs', rewriteOwnOrigin)
  }
}

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'mobile'),
  base: '/mobile/',
  publicDir: path.resolve(import.meta.dirname, 'mobile/public'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 19420,
    strictPort: true,
    cors: false,
    fs: { allow: [path.resolve(import.meta.dirname, '../..')] },
    proxy: { '/api': proxy, '/auth': proxy, '/login': proxy }
  },
  preview: {
    host: '127.0.0.1',
    port: 19420,
    strictPort: true,
    cors: false,
    proxy: { '/api': proxy, '/auth': proxy, '/login': proxy }
  },
  build: { outDir: '../dist-mobile', emptyOutDir: true, target: 'es2022', sourcemap: false }
})
