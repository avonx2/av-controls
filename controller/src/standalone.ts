// Standalone entry for the controller served on its own (index.html / npx).
// The library entry stays main.ts (`export default Controller`) so embedding
// apps (e.g. avonx-platform/frontend) are unaffected.
import './assets/standalone.css'
import './assets/main.css'
import { createApp } from 'vue'
import Standalone from './Standalone.vue'

createApp(Standalone).mount('#app')
