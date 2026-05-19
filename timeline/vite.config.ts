import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
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
      'av-controls': path.join(path.dirname(require.resolve('av-controls/package.json')), 'src/index.ts')
    }
  },
  optimizeDeps: {
    exclude: ['av-controls']
  },
  server: {
    watch: {
      ignored: ['!**/node_modules/av-controls/**']
    }, 
    port: 5175
  }
})
