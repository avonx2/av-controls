import { createApp, type App as VueApp } from 'vue'
import App from './App.vue'
import './style.css'

let app: VueApp<Element> | null = null

function mount() {
  app?.unmount()
  app = createApp(App)
  app.mount('#app')
}

mount()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    app?.unmount()
    app = null
  })
}
