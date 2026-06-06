<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  lastStateTime: number
  lastStateAt: number
  playing: boolean
  rendering: boolean
  renderLiveEnabled: boolean
  liveEnabled: boolean
  loopEnabled: boolean
  loopFromSec: number
  loopToSec: number
  fps: number
}>()

const emit = defineEmits<{
  seekZero: []
  jumpKeyframe: [direction: number]
  stepFrames: [delta: number]
  togglePlay: []
  toggleRenderLoop: []
  toggleRenderLive: []
  toggleLoop: []
  toggleLive: []
  'update:fps': [value: number]
  'update:loopFromSec': [value: number]
  'update:loopToSec': [value: number]
  seekTime: [value: number]
}>()

const displayedTime = ref(0)
let displayTimer: number | null = null

function syncDisplayedTime() {
  displayedTime.value = (props.playing && !props.rendering)
    ? Math.max(0, props.lastStateTime + (performance.now() - props.lastStateAt) / 1000)
    : props.lastStateTime
}

function onTimeInputChange(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isNaN(value) && Number.isFinite(value) && value >= 0) {
    emit('seekTime', value)
  } else {
    syncDisplayedTime()
  }
}

watch(
  () => [props.lastStateTime, props.lastStateAt, props.playing] as const,
  () => {
    syncDisplayedTime()
  },
  { immediate: true },
)

onMounted(() => {
  displayTimer = window.setInterval(() => {
    syncDisplayedTime()
  }, 100)
})

onBeforeUnmount(() => {
  if (displayTimer !== null) {
    clearInterval(displayTimer)
    displayTimer = null
  }
})
</script>

<template>
  <div class="timeline-footer">
    <button class="footer-btn" @click="emit('seekZero')">&laquo;</button>
    <button class="footer-btn" @click="emit('jumpKeyframe', -1)">◇</button>
    <button class="footer-btn" @click="emit('stepFrames', -1)">&lsaquo;</button>
    <div class="footer-duration">
      <button
        class="footer-btn render-live-btn"
        :class="{ active: renderLiveEnabled }"
        @click="emit('toggleRenderLive')"
        title="Render Live (HQ Preview)"
      >R</button>
      <button class="footer-btn" @click="emit('togglePlay')">{{ playing ? 'pause:' : 'play:' }}</button>
      <input
        :value="displayedTime.toFixed(2)"
        @change="onTimeInputChange"
        class="footer-input"
        type="text"
      />
    </div>
    <div class="footer-duration">
      <button
        class="footer-btn"
        :class="{ active: loopEnabled }"
        @click="emit('toggleLoop')"
      >loop:</button>
      <span class="footer-field-label">from</span>
      <input
        :value="loopFromSec"
        @input="emit('update:loopFromSec', Number(($event.target as HTMLInputElement).value))"
        class="footer-input"
        type="number"
        step="0.1"
      />
      <span class="footer-field-label">to</span>
      <input
        :value="loopToSec"
        @input="emit('update:loopToSec', Number(($event.target as HTMLInputElement).value))"
        class="footer-input"
        type="number"
        min="0"
        step="0.1"
      />
    </div>
    <div class="footer-fps">
      <span>FPS:</span>
      <input
        :value="fps"
        @input="emit('update:fps', Number(($event.target as HTMLInputElement).value))"
        class="footer-input"
        type="number"
        min="1"
        step="1"
      />
    </div>
    <div class="footer-render">
      <span>Render:</span>
      <button class="footer-btn" :class="{ active: rendering }" @click="emit('toggleRenderLoop')">range</button>
    </div>
    <button
      class="footer-btn"
      :class="{ active: liveEnabled }"
      @click="emit('toggleLive')"
    >Live</button>
    <button class="footer-btn" @click="emit('stepFrames', 1)">&rsaquo;</button>
    <button class="footer-btn" @click="emit('jumpKeyframe', 1)">◇</button>
    <button class="footer-btn">&raquo;</button>
  </div>
</template>

<style scoped>
.timeline-footer {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  justify-content: center;
  padding: 0.4rem 0.75rem;
  background: rgba(15, 17, 21, 0.9);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.footer-btn {
  background: rgba(255, 255, 255, 0.08);
  border: none;
  color: #fff;
  padding: 0.25rem 0.5rem;
  border-radius: 0.3rem;
  font-size: 0.8rem;
  cursor: pointer;
}

.footer-btn.active {
  background: rgba(80, 180, 120, 0.5);
}

.render-live-btn.active {
  background: rgba(212, 175, 55, 0.8) !important;
  color: #000;
  font-weight: bold;
}

.footer-fps {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.7);
}

.footer-render {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.7);
}

.footer-duration {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.footer-field-label {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.55);
}

.footer-input {
  width: 3.5rem;
  font-size: 0.8rem;
  line-height: 1.1;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  padding: 0.2rem 0.4rem;
  border-radius: 0.35rem;
  appearance: textfield;
  -moz-appearance: textfield;
}

.footer-input::-webkit-outer-spin-button,
.footer-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

</style>
