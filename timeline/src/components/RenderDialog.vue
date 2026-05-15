<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

type RenderConfig = {
  name: string
  fps: number
  startTime: number
  endTime: number
  outputFormat: 'live' | 'webp' | 'png' | 'mp4-avc' | 'mp4-hevc'
  imageWorkerCount: number
  width?: number
  height?: number
  quality: number
  testMode?: boolean
  frameLimit?: number
}

const props = defineProps<{
  loopDuration: number
  artworkName?: string
}>()

const emit = defineEmits<{
  start: [config: RenderConfig]
  test: [config: RenderConfig]
  close: []
}>()

// Render settings
const renderName = ref('')
const fpsPreset = ref<number | 'custom'>(60)
const customFps = ref(60)
const startTime = ref(0)
const endTime = ref(0)
const overrideResolution = ref(false)
const width = ref(1024)
const height = ref(1024)
const outputFormat = ref<'live' | 'webp' | 'png' | 'mp4-avc' | 'mp4-hevc'>('live')
const imageWorkerCount = ref(Math.min(4, navigator.hardwareConcurrency || 4))
const quality = ref(0.95)
const showInstructions = ref(true)

// Computed
const fps = computed(() => fpsPreset.value === 'custom' ? customFps.value : fpsPreset.value)
const totalFrames = computed(() => {
  const duration = endTime.value - startTime.value
  return Math.ceil(duration * fps.value)
})
const estimatedSize = computed(() => {
  const totalBytes = outputFormat.value === 'live'
    ? 0
    : outputFormat.value === 'png'
      ? totalFrames.value * 400000
      : outputFormat.value === 'webp'
        ? totalFrames.value * quality.value * 100000
        : totalFrames.value * quality.value * 150000
  return (totalBytes / 1024 / 1024).toFixed(1)
})

// Methods
function useLoopRange() {
  startTime.value = 0
  endTime.value = props.loopDuration
}

function loadSettings() {
  const stored = localStorage.getItem('render-settings')
  if (stored) {
    try {
      const settings = JSON.parse(stored)
      renderName.value = settings.name || generateDefaultName()
      fpsPreset.value = settings.fps || 60
      startTime.value = settings.startTime || 0
      endTime.value = settings.endTime || props.loopDuration
      overrideResolution.value = settings.overrideResolution || false
      width.value = settings.width || 1024
      height.value = settings.height || 1024
      outputFormat.value = settings.outputFormat || 'live'
      imageWorkerCount.value = settings.imageWorkerCount || Math.min(4, navigator.hardwareConcurrency || 4)
      quality.value = settings.quality || 0.95
    } catch (e) {
      console.warn('Failed to load render settings:', e)
      renderName.value = generateDefaultName()
    }
  } else {
    renderName.value = generateDefaultName()
    endTime.value = props.loopDuration
  }
}

function saveSettings() {
  const settings = {
    name: renderName.value,
    fps: fps.value,
    startTime: startTime.value,
    endTime: endTime.value,
    overrideResolution: overrideResolution.value,
    width: width.value,
    height: height.value,
    outputFormat: outputFormat.value,
    imageWorkerCount: imageWorkerCount.value,
    quality: quality.value,
  }
  localStorage.setItem('render-settings', JSON.stringify(settings))
}

function generateDefaultName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = props.artworkName || 'render'
  return `${base}-${timestamp}`
}

function buildConfig(testMode = false): RenderConfig {
  return {
    name: renderName.value,
    fps: fps.value,
    startTime: startTime.value,
    endTime: endTime.value,
    outputFormat: outputFormat.value,
    imageWorkerCount: imageWorkerCount.value,
    width: overrideResolution.value ? width.value : undefined,
    height: overrideResolution.value ? height.value : undefined,
    quality: quality.value,
    testMode,
    frameLimit: testMode ? 3 : undefined,
  }
}

function handleTest() {
  saveSettings()
  emit('test', buildConfig(true))
}

function handleStart() {
  saveSettings()
  emit('start', buildConfig(false))
}

onMounted(() => {
  loadSettings()
})

watch(() => props.loopDuration, (newVal) => {
  if (endTime.value === 0) {
    endTime.value = newVal
  }
})
</script>

<template>
  <div class="render-dialog-overlay" @click.self="emit('close')">
    <div class="render-dialog">
      <h2>Render Settings</h2>

      <div class="render-field">
        <label>Render Name:</label>
        <input v-model="renderName" type="text" class="render-input" />
        <span class="hint">
          {{ outputFormat === 'png'
            ? 'Format: {name}-{frame}.png'
            : outputFormat === 'webp'
              ? 'Format: {name}-{frame}.webp'
              : outputFormat === 'live'
                ? 'No files will be written'
                : 'Format: {name}.mp4' }}
        </span>
      </div>

      <div class="render-field">
        <label>Output:</label>
        <select v-model="outputFormat" class="render-select">
          <option value="live">Live preview (no downloads)</option>
          <option value="webp">WebP sequence</option>
          <option value="png">PNG sequence</option>
          <option value="mp4-avc">MP4 video (H.264)</option>
          <option value="mp4-hevc">MP4 video (H.265)</option>
        </select>
      </div>

      <div v-if="outputFormat === 'webp' || outputFormat === 'png'" class="render-field">
        <label>Image Workers:</label>
        <input
          v-model.number="imageWorkerCount"
          type="number"
          class="render-input-small"
          min="1"
          max="16"
        />
      </div>

      <div class="render-field">
        <label>FPS:</label>
        <select v-model="fpsPreset" class="render-select">
          <option :value="30">30</option>
          <option :value="60">60</option>
          <option :value="120">120</option>
          <option value="custom">Custom</option>
        </select>
        <input
          v-if="fpsPreset === 'custom'"
          v-model.number="customFps"
          type="number"
          class="render-input-small"
          min="1"
          max="240"
        />
      </div>

      <div class="render-field">
        <label>Timeline Range:</label>
        <div class="range-inputs">
          <input v-model.number="startTime" type="number" step="0.1" class="render-input-small" />
          <span>to</span>
          <input v-model.number="endTime" type="number" step="0.1" class="render-input-small" />
          <span>seconds</span>
          <button @click="useLoopRange" class="render-btn-small">Use Loop Range</button>
        </div>
      </div>

      <div class="render-field">
        <label>
          <input v-model="overrideResolution" type="checkbox" />
          Override Resolution
        </label>
        <div v-if="overrideResolution" class="resolution-inputs">
          <input v-model.number="width" type="number" class="render-input-small" />
          <span>×</span>
          <input v-model.number="height" type="number" class="render-input-small" />
        </div>
      </div>

      <div v-if="outputFormat === 'webp' || outputFormat === 'mp4-avc' || outputFormat === 'mp4-hevc'" class="render-field">
        <label>{{ outputFormat === 'webp' ? 'WebP Quality' : 'Video Quality' }}: {{ quality.toFixed(2) }}</label>
        <input v-model.number="quality" type="range" min="0.8" max="1.0" step="0.01" class="quality-slider" />
      </div>

      <div class="render-info">
        <p><strong>Total frames:</strong> {{ totalFrames }}</p>
        <p v-if="outputFormat !== 'live'"><strong>Estimated size:</strong> ~{{ estimatedSize }} MB</p>
        <p v-else><strong>Estimated size:</strong> no downloads</p>
      </div>

      <div class="download-instructions" :class="{ collapsed: !showInstructions }">
        <button @click="showInstructions = !showInstructions" class="instructions-toggle">
          {{ showInstructions ? '▼' : '▶' }} Browser Download Setup
        </button>
        <div v-if="showInstructions" class="instructions-content">
          <template v-if="outputFormat === 'png' || outputFormat === 'webp'">
            <p>To avoid download prompts for each frame:</p>
            <ol>
              <li>Open browser settings → Downloads</li>
              <li>Set download location to your desired folder</li>
              <li>Disable "Ask where to save each file before downloading"</li>
            </ol>
            <p class="warning">⚠️ All frames will download to this folder automatically</p>
          </template>
          <template v-else-if="outputFormat === 'live'">
            <p>Frames are rendered through the export path at the selected FPS without writing files.</p>
          </template>
          <template v-else>
            <p>The video export writes a single MP4 file after rendering finishes.</p>
            <p class="warning">⚠️ H.265 depends on browser encoder support and may not work in every browser.</p>
          </template>
        </div>
      </div>

      <div class="render-actions">
        <button @click="handleTest" class="render-btn">Test (3 frames)</button>
        <button @click="emit('close')" class="render-btn">Cancel</button>
        <button @click="handleStart" class="render-btn render-btn-primary">Start Render</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.render-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.render-dialog {
  background: rgba(20, 22, 28, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 0.5rem;
  padding: 1.5rem;
  max-width: 600px;
  width: 90%;
  max-height: 90vh;
  overflow-y: auto;
}

.render-dialog h2 {
  margin: 0 0 1.5rem 0;
  color: #fff;
  font-size: 1.5rem;
}

.render-field {
  margin-bottom: 1.25rem;

  & label {
    display: block;
    color: rgba(255, 255, 255, 0.9);
    margin-bottom: 0.5rem;
    font-size: 0.9rem;
  }

  & .hint {
    display: block;
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.75rem;
    margin-top: 0.25rem;
  }
}

.render-input,
.render-select {
  width: 100%;
  padding: 0.5rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 0.3rem;
  color: #fff;
  font-size: 0.9rem;

  &:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.3);
  }
}

.render-input-small {
  width: 80px;
  padding: 0.4rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 0.3rem;
  color: #fff;
  font-size: 0.85rem;
}

.range-inputs,
.resolution-inputs {
  display: flex;
  align-items: center;
  gap: 0.5rem;

  & span {
    color: rgba(255, 255, 255, 0.7);
  }
}

.render-btn-small {
  padding: 0.4rem 0.75rem;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 0.3rem;
  color: #fff;
  font-size: 0.8rem;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.15);
  }
}

.quality-slider {
  width: 100%;
}

.render-info {
  background: rgba(255, 255, 255, 0.05);
  padding: 1rem;
  border-radius: 0.3rem;
  margin-bottom: 1.25rem;

  & p {
    margin: 0.25rem 0;
    color: rgba(255, 255, 255, 0.9);
    font-size: 0.9rem;
  }
}

.download-instructions {
  background: rgba(100, 150, 255, 0.1);
  border: 1px solid rgba(100, 150, 255, 0.3);
  border-radius: 0.3rem;
  margin-bottom: 1.25rem;
  overflow: hidden;

  &.collapsed .instructions-content {
    display: none;
  }
}

.instructions-toggle {
  width: 100%;
  text-align: left;
  padding: 0.75rem;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.9rem;
  cursor: pointer;

  &:hover {
    background: rgba(100, 150, 255, 0.05);
  }
}

.instructions-content {
  padding: 0 0.75rem 0.75rem 0.75rem;
  color: rgba(255, 255, 255, 0.8);
  font-size: 0.85rem;

  & ol {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }

  & li {
    margin: 0.25rem 0;
  }

  & .warning {
    margin-top: 0.75rem;
    color: #ffaa00;
  }

  & code {
    background: rgba(255, 255, 255, 0.1);
    padding: 0.1rem 0.3rem;
    border-radius: 0.2rem;
    font-family: monospace;
    font-size: 0.8rem;
  }
}

.render-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}

.render-btn {
  padding: 0.6rem 1.25rem;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 0.3rem;
  color: #fff;
  font-size: 0.9rem;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  &.render-btn-primary {
    background: rgba(100, 150, 255, 0.3);
    border-color: rgba(100, 150, 255, 0.5);

    &:hover {
      background: rgba(100, 150, 255, 0.4);
    }
  }
}
</style>
