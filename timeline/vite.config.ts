import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default defineConfig({
  base: './',
  plugins: [vue()],
  define: {
    'process.env': {}
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@av-controls/protocol': path.join(path.dirname(require.resolve('@av-controls/protocol/package.json')), 'src/index.ts')
    }
  },
  optimizeDeps: {
    exclude: ['@av-controls/protocol']
  },
  server: {
    https: {
      key: fs.readFileSync(path.resolve(__dirname, '../../certs/dome.key')),
      cert: fs.readFileSync(path.resolve(__dirname, '../../certs/dome.crt')),
    },
    watch: {
      ignored: ['!**/node_modules/@av-controls/protocol/**']
    }, 
    port: 5175,
    proxy: {
      '/ws-broker': {
        target: `ws://127.0.0.1:8080`,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/ws-broker/, ''),
      },
    },
  }
})
