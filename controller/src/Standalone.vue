<script setup lang="ts">
// Standalone bootstrap for the controller when served on its own (e.g. `npx
// @av-controls/controller`). NOT used when the controller is imported as a
// component by another app (that path goes through main.ts -> Controller.vue,
// which is left untouched).
//
// URL params decide the transport:
//   ?net=ws://host:port   -> connect to an av-controls WebSocket broker
//   ?tab=http://host:port -> open that artwork in a tab and control it directly
// With no param we show a small connection form; submitting it sets the param
// in the location and reloads, so a reload reconnects immediately.
import { ref, shallowRef, onMounted, onBeforeUnmount } from 'vue'
import Controller from './components/Controller.vue'
import { Transports } from '@av-controls/protocol'

// Empty by default: with no ?net= param the connect page shows an empty broker
// field (operator types e.g. ws://felix-pc:8080 + the controller password).
const DEFAULT_WS = ''
const DEFAULT_TAB = 'http://localhost:5173'

type Mode = 'connect' | 'net' | 'tab'
const mode = ref<Mode>('connect')
const error = ref('')

const netUrl = ref(DEFAULT_WS)
const netPassword = ref('')
const tabUrl = ref(DEFAULT_TAB)

// For exhibition / protected brokers, password is entered here and appended
// as ?password=... query param on the WS URL (broker can inspect it).

const controller = ref<InstanceType<typeof Controller> | null>(null)

function sanitizeUrlForDisplay(u: string) {
  try {
    const url = new URL(u)
    url.searchParams.delete('password')
    url.searchParams.delete('pw')
    return url.toString()
  } catch {
    return u
  }
}

// --- net (WebSocket broker) ---
const wsSender = shallowRef<Transports.WebSocket.Sender | null>(null)
const panelIds = ref<string[]>([])
const panelChosen = ref(false)
const choosePanelResolve = ref<((id: string) => void) | null>(null)

function choosePanel(ids: string[]): Promise<string> {
  panelIds.value = ids
  return new Promise<string>((resolve) => {
    if (ids.length === 1) {
      panelChosen.value = true
      resolve(ids[0]!)
      return
    }
    choosePanelResolve.value = (id: string) => {
      panelChosen.value = true
      choosePanelResolve.value = null
      resolve(id)
    }
  })
}

function connectNet(url: string) {
  if (!url.startsWith('ws')) {
    error.value = 'Net panel URL must start with ws:// or wss://'
    mode.value = 'connect'
    return
  }
  mode.value = 'net'
  wsSender.value = new Transports.WebSocket.Sender(url, choosePanel)
}

// --- tab (window) ---
const tabSender = shallowRef<Transports.Window.Sender | null>(null)

function connectTab(url: string) {
  mode.value = 'tab'
  const tab = window.open(url)
  if (!tab) {
    error.value = 'Could not open the artwork tab (popup blocked?).'
    mode.value = 'connect'
    return
  }
  tabSender.value = new Transports.Window.Sender(tab)
}

onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  const net = params.get('net')
  const tab = params.get('tab')
  let pw = params.get('password') || params.get('pw') || ''
  if (net) {
    try {
      const u = new URL(net)
      const pwInUrl = u.searchParams.get('password') || u.searchParams.get('pw') || ''
      if (pwInUrl) {
        pw = pwInUrl
        u.searchParams.delete('password')
        u.searchParams.delete('pw')
        // netUrl will be set to cleaned
      }
      netUrl.value = u.toString()
    } catch {
      netUrl.value = net
    }
  }
  if (pw) netPassword.value = pw
  if (net) {
    let connectUrl = netUrl.value
    if (pw) {
      try {
        const u = new URL(connectUrl)
        u.searchParams.set('password', pw)
        connectUrl = u.toString()
      } catch {}
    }
    connectNet(connectUrl)
  }
  else if (tab) connectTab(tab)
  else mode.value = 'connect'
})

onBeforeUnmount(() => {
  wsSender.value?.dispose?.()
  tabSender.value?.destroy?.()
})

// --- connect form: set the param and reload (so reloads reconnect) ---
function submitNet() {
  let finalUrl = netUrl.value.trim()
  if (netPassword.value) {
    try {
      const u = new URL(finalUrl)
      u.searchParams.set('password', netPassword.value)
      finalUrl = u.toString()
    } catch {
      error.value = 'Net panel URL must be a valid ws:// or wss:// URL'
      return
    }
  }
  window.location.search = new URLSearchParams({ net: finalUrl }).toString()
}
function submitTab() {
  window.location.search = new URLSearchParams({ tab: tabUrl.value }).toString()
}
function backToConnect() {
  window.location.search = ''
}

// --- optional controller header actions ---
const showMidiMapper = ref(false)
const deletingMapping = ref(false)
const layoutEditMode = ref(false)
function toggleLayoutEditMode() {
  layoutEditMode.value = !layoutEditMode.value
  controller.value?.setLayoutEditMode(layoutEditMode.value)
}

const isConnected = () =>
  (mode.value === 'net' && wsSender.value !== null && panelChosen.value) ||
  (mode.value === 'tab' && tabSender.value !== null)
</script>

<template>
  <!-- connected: show the controller -->
  <div v-if="isConnected()" class="controls-page">
    <div class="bar">
      <button class="back" @click="backToConnect">↩ connection</button>
      <div class="actions">
        <button :class="{ active: showMidiMapper }"
          @click="controller?.toggleMidiMapper(showMidiMapper = !showMidiMapper)">
          {{ showMidiMapper ? 'stop mapping' : 'add mapping' }}
        </button>
        <button :class="{ active: deletingMapping }"
          @click="controller?.setRemovingMapping(deletingMapping = !deletingMapping)">
          {{ deletingMapping ? 'stop deleting' : 'delete mapping' }}
        </button>
        <button @click="controller?.manageMappings()">mappings</button>
        <button @click="controller?.exportControlValues()">export</button>
        <button @click="controller?.importControlValues()">import</button>
        <button :class="{ active: layoutEditMode }" @click="toggleLayoutEditMode">
          {{ layoutEditMode ? 'stop layout' : 'layout' }}
        </button>
      </div>
    </div>
    <Controller ref="controller" :sender="(wsSender ?? tabSender)!" @doneMapping="showMidiMapper = false" />
  </div>

  <!-- net: choosing a panel / waiting -->
  <div v-else-if="mode === 'net'" class="center">
    <template v-if="choosePanelResolve && panelIds.length > 1">
      <p>Choose a net panel</p>
      <div class="panels">
        <button v-for="id in panelIds" :key="id" @click="choosePanelResolve(id)">{{ id }}</button>
      </div>
    </template>
    <p v-else>Connecting to {{ sanitizeUrlForDisplay(netUrl) }} — waiting for panel list…</p>
    <button class="link" @click="backToConnect">cancel</button>
  </div>

  <!-- tab: waiting for the artwork window to answer -->
  <div v-else-if="mode === 'tab'" class="center">
    <p>Opened the artwork tab — waiting for its controls…</p>
    <button class="link" @click="backToConnect">cancel</button>
  </div>

  <!-- no params: connection form -->
  <div v-else class="connect">
    <h1>av controller</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="card">
      <h2>Net panel</h2>
      <p>Connect to an av-controls WebSocket broker.</p>
      <input v-model="netUrl" spellcheck="false" placeholder="ws://host:port" @keyup.enter="submitNet" />
      <input v-model="netPassword" type="password" spellcheck="false" placeholder="Password (optional)" @keyup.enter="submitNet" />
      <button @click="submitNet">Connect</button>
    </div>
    <div class="card">
      <h2>Tab</h2>
      <p>Open an artwork in a tab and control it directly.</p>
      <input v-model="tabUrl" spellcheck="false" @keyup.enter="submitTab" />
      <button @click="submitTab">Open</button>
    </div>
  </div>
</template>

<style scoped>
.controls-page {
  height: 100dvh;
  width: 100%;
  display: flex;
  flex-direction: column;
}
.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background-color: #444;
  padding: 0.25rem;
}
.bar button {
  background-color: #222;
  color: #fff;
  padding: 0.6rem 0.75rem;
  border-radius: 0.5rem;
  border: none;
  margin: 0.2rem;
  cursor: pointer;
}
.bar button.active { background-color: #285a8f; }

.center,
.connect {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  color: #ddd;
  font-family: sans-serif;
  background-color: #1a1a1a;
  padding: 2rem;
}
.connect h1 { margin: 0 0 0.5rem; font-weight: 500; }
.card {
  background-color: #262626;
  border: 1px solid #3a3a3a;
  border-radius: 0.75rem;
  padding: 1.25rem;
  width: min(28rem, 90vw);
}
.card h2 { margin: 0 0 0.25rem; font-size: 1.1rem; }
.card p { margin: 0 0 0.75rem; color: #999; font-size: 0.9rem; }
.card input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.6rem 0.7rem;
  border-radius: 0.5rem;
  border: 1px solid #444;
  background-color: #111;
  color: #fff;
  margin-bottom: 0.6rem;
}
.card button,
.panels button {
  background-color: #285a8f;
  color: #fff;
  border: none;
  border-radius: 0.5rem;
  padding: 0.6rem 1rem;
  cursor: pointer;
}
.panels { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: center; }
.link { background: none; border: none; color: #6aa6e0; cursor: pointer; }
.error { color: #e08a8a; }
</style>
