import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default defineConfig({
  base: './',
  plugins: [
    vue(),
  ],
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
    exclude: ['@av-controls/protocol', '@av-controls/reconcile-ui']
  },
  server: {
    watch: {
      // Watch npm linked packages for changes
      ignored: ['!**/node_modules/@av-controls/protocol/**', '!**/node_modules/@av-controls/reconcile-ui/**']
    }
  }
})
