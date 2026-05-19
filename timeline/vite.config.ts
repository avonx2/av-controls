import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  base: './',
  plugins: [vue()],
  define: {
    'process.env': {}
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'av-controls': path.resolve(__dirname, '../protocol/src/index.ts')
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
