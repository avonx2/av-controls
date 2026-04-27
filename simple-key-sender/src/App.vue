<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Transports, Messages, Controls, createSenderFromSpec } from 'av-controls'

interface PadInfo {
  path: string
  sender: Controls.Pad.Sender
}

interface KeyMapping {
  key: string
  padPath: string
  padSender: Controls.Pad.Sender
}

const wsUrl = ref(localStorage.getItem('wsUrl') || 'ws://localhost:8080')
const connected = ref(false)
const wsSender = ref<Transports.WebSocket.Sender | null>(null)
const rootSender = ref<Controls.Base.Sender | null>(null)
const panelName = ref('')

const allPads = ref<PadInfo[]>([])
const searchQuery = ref('')
const selectedPadPath = ref<string | null>(null)
const mappings = ref<KeyMapping[]>([])
const activeMappingKey = ref<string | null>(null)

const filteredPads = computed(() => {
  if (!searchQuery.value) return allPads.value
  const query = searchQuery.value.toLowerCase()
  return allPads.value.filter(pad => pad.path.toLowerCase().includes(query))
})

async function connect() {
  console.log('Connecting to:', wsUrl.value)

  // Disconnect if already connected
  if (wsSender.value) {
    wsSender.value.dispose()
    wsSender.value = null
    connected.value = false
  }

  try {
    wsSender.value = new Transports.WebSocket.Sender(
      wsUrl.value,
      chooseNetPanel,
      {
        onPanelList: (panelIds) => {
          if (panelIds.length > 0) return
          connected.value = false
          panelName.value = ''
          rootSender.value = null
          allPads.value = []
        }
      }
    )
    console.log('Created Sender, waiting for panel attachment...')

    // Save URL on successful connection
    localStorage.setItem('wsUrl', wsUrl.value)

    wsSender.value.addListener((data) => {
      console.log('Received message:', data.type, data)
      const type = data.type
      if (type === Messages.RootSpecification.type) {
        const spec = data as Messages.RootSpecification
        console.log('Got RootSpecification:', spec.name, spec.rootControlSpec)
        panelName.value = spec.name
        connected.value = true

        rootSender.value = createSenderFromSpec(spec.rootControlSpec)
        rootSender.value.onSignal = (signal: Controls.Base.Signal) => {
          wsSender.value?.send(new Messages.ControlSignal(signal))
        }

        allPads.value = discoverPads(rootSender.value)
        console.log('Discovered pads:', allPads.value)
        loadMappings()
      } else if (type === Messages.ControlUpdate.type) {
        const update = data as Messages.ControlUpdate
        rootSender.value?.handleUpdate(update.update)
      }
    })
    console.log('Listener added')
  } catch (error) {
    console.error('Failed to connect:', error)
  }
}

function chooseNetPanel(availablePanelIds: string[]) {
  console.log('chooseNetPanel called with:', availablePanelIds)
  return new Promise<string>((resolve) => {
    if (availablePanelIds.length === 1) {
      console.log('Auto-selecting panel:', availablePanelIds[0])
      resolve(availablePanelIds[0]!)
      return
    }
    // For simplicity, just pick the first one
    console.log('Selecting first panel:', availablePanelIds[0])
    resolve(availablePanelIds[0]!)
  })
}

function buildPadPath(sender: Controls.Base.Sender): string {
  const parts: string[] = []
  let current: Controls.Base.Sender | undefined = sender

  while (current) {
    parts.unshift(current.spec.name)
    current = current.parent
  }

  return parts.join('/')
}

function discoverPads(sender: Controls.Base.Sender) {
  const pads: PadInfo[] = []

  sender.deepForeach((s) => {
    if (s.spec.type === 'pad') {
      pads.push({
        path: buildPadPath(s),
        sender: s as Controls.Pad.Sender
      })
    }
  })

  // Remove common prefix from all paths
  if (pads.length > 0) {
    const pathParts = pads.map(p => p.path.split('/'))
    let commonPrefixLength = 0

    if (pathParts.length > 0) {
      const firstPath = pathParts[0]!
      for (let i = 0; i < firstPath.length; i++) {
        const part = firstPath[i]
        if (pathParts.every(path => path[i] === part)) {
          commonPrefixLength = i + 1
        } else {
          break
        }
      }
    }

    if (commonPrefixLength > 0) {
      pads.forEach(pad => {
        const parts = pad.path.split('/')
        pad.path = parts.slice(commonPrefixLength).join('/') || parts[parts.length - 1]!
      })
    }
  }

  return pads
}

function selectPad(pad: PadInfo) {
  selectedPadPath.value = pad.path
}

function handleKeyDown(event: KeyboardEvent) {
  // Ignore key events when typing in input fields
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    return
  }

  const key = event.key

  // If we're selecting a pad for mapping
  if (selectedPadPath.value) {
    const selectedPad = allPads.value.find(p => p.path === selectedPadPath.value)
    if (selectedPad) {
      // Remove existing mapping for this key if any
      mappings.value = mappings.value.filter(m => m.key !== key)

      // Add new mapping
      mappings.value.push({
        key,
        padPath: selectedPad.path,
        padSender: selectedPad.sender
      })

      selectedPadPath.value = null
      saveMappings()
      return
    }
  }

  // Check if key is mapped
  const mapping = mappings.value.find(m => m.key === key)
  if (mapping && !event.repeat) {
    mapping.padSender.press(1.0)
    activeMappingKey.value = key
  }
}

function handleKeyUp(event: KeyboardEvent) {
  // Ignore key events when typing in input fields
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    return
  }

  const key = event.key
  const mapping = mappings.value.find(m => m.key === key)

  if (mapping) {
    mapping.padSender.release()
    if (activeMappingKey.value === key) {
      activeMappingKey.value = null
    }
  }
}

function removeMapping(index: number) {
  mappings.value.splice(index, 1)
  saveMappings()
}

function saveMappings() {
  if (!panelName.value) return

  const serialized = mappings.value.map(m => ({
    key: m.key,
    padPath: m.padPath
  }))

  localStorage.setItem(`mappings_${panelName.value}`, JSON.stringify(serialized))
}

function loadMappings() {
  if (!panelName.value) return

  const saved = localStorage.getItem(`mappings_${panelName.value}`)
  if (!saved) return

  try {
    const serialized = JSON.parse(saved)
    mappings.value = serialized
      .map((m: { key: string, padPath: string }) => {
        const pad = allPads.value.find(p => p.path === m.padPath)
        if (!pad) return null
        return {
          key: m.key,
          padPath: m.padPath,
          padSender: pad.sender
        }
      })
      .filter((m: KeyMapping | null) => m !== null)
  } catch (error) {
    console.error('Failed to load mappings:', error)
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)

  // Auto-connect on load
  connect()
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  wsSender.value?.dispose()
})
</script>

<template>
  <div class="app">
    <div class="connection-bar">
      <input
        v-model="wsUrl"
        type="text"
        placeholder="WebSocket URL"
      />
      <button @click="connect">
        {{ connected ? 'Reconnect' : 'Connect' }}
      </button>
    </div>

    <div v-if="connected" class="main-content">
      <div class="section">
        <h2>Pads</h2>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search pads..."
          class="search-input"
        />
        <ul class="pad-list">
          <li
            v-for="pad in filteredPads"
            :key="pad.path"
            @click="selectPad(pad)"
            :class="{ selected: selectedPadPath === pad.path }"
          >
            {{ pad.path }}
          </li>
        </ul>
      </div>

      <div class="section">
        <h2>Mappings</h2>
        <p v-if="selectedPadPath" class="hint">Press any key to map to {{ selectedPadPath }}</p>
        <ul class="mapping-list">
          <li
            v-for="(mapping, index) in mappings"
            :key="index"
            :class="{ active: activeMappingKey === mapping.key }"
          >
            <span class="mapping-key">{{ mapping.key }}</span>
            <span class="arrow">→</span>
            <span class="mapping-path">{{ mapping.padPath }}</span>
            <button @click="removeMapping(index)" class="remove-btn">×</button>
          </li>
        </ul>
      </div>
    </div>

    <div v-else class="waiting">
      <p>Enter WebSocket URL and click Connect</p>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 1rem;
}

.connection-bar {
  display: flex;
  gap: 0.5rem;

  & input {
    flex: 1;
  }
}

.main-content {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  flex: 1;
  overflow: hidden;
}

.section {
  display: flex;
  flex-direction: column;
  border: 1px solid #444;
  padding: 1rem;
  border-radius: 4px;
  overflow: hidden;

  & h2 {
    margin-bottom: 0.5rem;
    font-size: 1.2rem;
  }
}

.search-input {
  margin-bottom: 0.5rem;
}

.pad-list, .mapping-list {
  flex: 1;
  overflow-y: auto;

  & li {
    padding: 0.5rem;
    cursor: pointer;
    border-bottom: 1px solid #333;

    &:hover {
      background-color: #2a2a2a;
    }

    &.selected {
      background-color: #444;
      font-weight: bold;
    }

    &.active {
      background-color: #4a4a00;
    }
  }
}

.mapping-list li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.mapping-key {
  font-weight: bold;
  background-color: #333;
  padding: 0.2rem 0.4rem;
  border-radius: 3px;
  min-width: 3rem;
  text-align: center;
}

.arrow {
  color: #888;
}

.mapping-path {
  flex: 1;
}

.remove-btn {
  padding: 0.2rem 0.5rem;
  font-size: 1.2rem;
  line-height: 1;
  background-color: #600;

  &:hover {
    background-color: #800;
  }
}

.hint {
  font-style: italic;
  color: #aaa;
  margin-bottom: 0.5rem;
}

.waiting {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: #888;
}
</style>
