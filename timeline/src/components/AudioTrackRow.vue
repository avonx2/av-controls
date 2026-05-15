<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { StoredWaveform } from '../storage'

const props = defineProps<{
  width: number
  labelWidth: number
  secondsPerWidth: number
  timeOffset: number
  expanded: boolean
  snapEnabled: boolean
  waveform: StoredWaveform | null
  duration: number
  fileName: string | null
  missingFileName: string | null
}>()

const emit = defineEmits<{
  'toggle:expanded': []
  'toggle:snap': []
  'upload': [payload: { file: File; markerTime?: number }]
  'toggle:marker': [time: number]
  'hover:time': [time: number | null]
  'wheel': [event: WheelEvent]
}>()

const fileInputRef = ref<HTMLInputElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const pendingMarkerTime = ref<number | null>(null)
let drawRaf = 0

function hasRenderableWaveform() {
  return !!props.waveform && Array.isArray(props.waveform.levels) && props.waveform.levels.length > 0
}

function xToTime(x: number) {
  if (!props.width) return 0
  return (x / props.width) * props.secondsPerWidth + props.timeOffset
}

function onUploadClick() {
  fileInputRef.value?.click()
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) return
  emit('upload', {
    file,
    markerTime: pendingMarkerTime.value ?? undefined,
  })
  pendingMarkerTime.value = null
  if (input) input.value = ''
}

function onWavePointerDown(event: PointerEvent) {
  if (props.width <= 0) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const time = Math.max(0, xToTime(event.clientX - rect.left))
  if (!props.fileName) {
    pendingMarkerTime.value = time
    onUploadClick()
    return
  }
  if (!props.expanded) return
  emit('toggle:marker', time)
}

function onWavePointerMove(event: PointerEvent) {
  if (props.width <= 0 || !props.expanded || !props.fileName) {
    emit('hover:time', null)
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit('hover:time', Math.max(0, xToTime(event.clientX - rect.left)))
}

function onWheel(event: WheelEvent) {
  emit('wheel', event)
}

function pickLevel() {
  const waveform = props.waveform
  if (!hasRenderableWaveform() || !waveform || props.width <= 0) return null
  const targetSecondsPerPixel = props.secondsPerWidth / Math.max(1, props.width)
  let best = waveform.levels[0]!

  for (const level of waveform.levels) {
    const secondsPerBin = level.binSamples / waveform.sampleRate
    if (secondsPerBin <= targetSecondsPerPixel) {
      best = level
    } else {
      break
    }    
  }

  return best
}

function drawWaveform() {
  drawRaf = 0
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(rect.width * dpr))
  const height = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)

  if (!props.expanded || !props.waveform || !props.fileName || props.width <= 0) return

  const level = pickLevel()
  if (!level || !level.values.length) return

  const centerY = height * 0.5
  const amplitude = height * 0.42
  const visibleStart = props.timeOffset
  const visibleEnd = props.timeOffset + props.secondsPerWidth
  const binDuration = level.binSamples / props.waveform.sampleRate
  const secondsPerPixel = Math.max(1e-9, props.secondsPerWidth / Math.max(1, width))

  ctx.strokeStyle = '#8fe7f3'
  ctx.lineWidth = Math.max(1, dpr)
  ctx.beginPath()

  for (let px = 0; px < width; px++) {
    const pixelTime = visibleStart + (px + 0.5) * secondsPerPixel
    if (pixelTime < 0) continue
    const bucketIndex = Math.max(0, Math.min(level.values.length - 1, Math.floor(pixelTime / binDuration)))
    const value = Math.max(0, Math.min(1, level.values[bucketIndex] ?? 0))
    const y = value * amplitude
    const x = px + 0.5
    ctx.moveTo(x, centerY - y)
    ctx.lineTo(x, centerY + y)
  }

  ctx.stroke()
}

function scheduleDraw() {
  if (drawRaf) return
  drawRaf = requestAnimationFrame(drawWaveform)
}

watch(
  () => [
    props.waveform?.hash ?? null,
    props.waveform?.sampleRate ?? 0,
    props.waveform?.baseBinSamples ?? 0,
    props.waveform?.levels.length ?? 0,
    props.width,
    props.secondsPerWidth,
    props.timeOffset,
    props.expanded,
    props.fileName,
  ],
  () => {
    nextTick(() => {
      scheduleDraw()
    })
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (drawRaf) cancelAnimationFrame(drawRaf)
})
</script>

<template>
  <div class="audio-row" :class="{ expanded }">
    <div class="audio-labels" :style="{ width: `${labelWidth}px` }" @click="emit('toggle:expanded')">
      <div class="audio-label-header">
        <div class="audio-title">audio</div>
      </div>
      <div class="audio-meta">
        <div v-if="expanded" class="audio-actions">
          <button class="audio-action" :class="{ active: snapEnabled }" @click.stop="emit('toggle:snap')">Snap</button>
          <button class="audio-action" @click.stop="onUploadClick">Upload</button>
        </div>
        <div class="audio-file">{{ expanded ? (fileName || 'No track loaded') : '' }}</div>
      </div>
      <input ref="fileInputRef" class="audio-file-input" type="file" accept="audio/*" @change="onFileChange">
    </div>
    <div class="audio-lane" :class="{ expanded }" @click="expanded ? undefined : emit('toggle:expanded')" @wheel.prevent="onWheel">
      <div class="audio-surface" @pointerdown="onWavePointerDown" @pointermove="onWavePointerMove" @pointerleave="emit('hover:time', null)">
        <canvas ref="canvasRef" class="audio-canvas" />
      </div>
      <div v-if="!expanded" class="audio-collapsed-hint" />
      <div v-else-if="missingFileName" class="audio-empty-hint is-missing">specified track not available, please upload "{{ missingFileName }}"</div>
      <div v-else-if="!hasRenderableWaveform()" class="audio-empty-hint">upload a track to show the waveform</div>
    </div>
  </div>
</template>

<style scoped>
.audio-row {
  display: flex;
  align-items: stretch;
  min-height: 28px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(17, 22, 29, 0.98), rgba(12, 16, 21, 0.98));
}

.audio-row.expanded {
  min-height: 6rem;
}

.audio-labels {
  flex: 0 0 auto;
  padding: 0 0.4rem;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  justify-content: center;
  cursor: pointer;
}

.audio-label-header {
  display: flex;
  align-items: center;
  min-height: 28px;
}

.audio-action {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 0.35rem;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(242, 246, 250, 0.9);
  font-size: 0.68rem;
  line-height: 1;
  padding: 0.16rem 0.45rem;
  cursor: pointer;
  opacity: 0.8;
}

.audio-action.active {
  opacity: 1;
  background: rgba(212, 154, 52, 0.7);
  border-color: rgba(255, 210, 120, 0.28);
}

.audio-action:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.18);
}

.audio-actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.audio-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.audio-title {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(243, 242, 238, 0.6);
}

.audio-file {
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.86);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.audio-file-input {
  display: none;
}

.audio-lane {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  background: linear-gradient(180deg, rgba(28, 38, 49, 0.2), rgba(13, 19, 25, 0.24));
}

.audio-lane:not(.expanded) {
  cursor: pointer;
}

.audio-surface {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: var(--lane-gap, 0.8rem);
  cursor: text;
}

.audio-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.audio-empty-hint,
.audio-collapsed-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.78rem;
  pointer-events: none;
}

.audio-empty-hint.is-missing {
  inset-inline: calc(var(--lane-gap, 0.8rem) + 1rem) 1rem;
  color: #f88;
  text-align: center;
  white-space: normal;
  line-height: 1.35;
}
</style>
