<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { mix, transparentize } from 'polished'
import { Controls } from 'av-controls'

const props = defineProps({
  lamp: {
    type: Object as () => Controls.Lamp.Sender,
    required: true,
  },
})

const nowMs = ref(Date.now())
let animationFrameId = 0

const intensity = computed(() => props.lamp.getValueAt(nowMs.value))
const backgroundColor = computed(() => transparentize(0.8, props.lamp.spec.color))
const centerColor = computed(() => mix(intensity.value, '#ffffff', props.lamp.spec.color))
const midColor = computed(() => mix(intensity.value * 0.45, '#ffffff', props.lamp.spec.color))

const containerStyle = computed(() => ({
  backgroundColor: backgroundColor.value,
}))

const lampStyle = computed(() => ({
  background: `radial-gradient(circle, ${centerColor.value} 0%, ${midColor.value} 45%, ${backgroundColor.value} 100%)`,
}))

function stopAnimation() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = 0
  }
}

function tick() {
  nowMs.value = Date.now()
  if (props.lamp.getValueAt(nowMs.value) > 0.003) {
    animationFrameId = requestAnimationFrame(tick)
  } else {
    stopAnimation()
  }
}

function ensureAnimation() {
  if (!animationFrameId) {
    animationFrameId = requestAnimationFrame(tick)
  }
}

watch(() => props.lamp.flashVersion, () => {
  nowMs.value = Date.now()
  ensureAnimation()
})

onMounted(() => {
  if (props.lamp.getValueAt() > 0.003) {
    ensureAnimation()
  }
})

onBeforeUnmount(() => {
  stopAnimation()
})
</script>

<template>
  <div class="container" :style="containerStyle">
    <div class="lamp-circle" :style="lampStyle"></div>
    <div class="centered-label lamp-label">{{ props.lamp.spec.name }}</div>
  </div>
</template>

<style scoped>
@import './meter-styles.css';

.container {
  position: absolute;
  left: 0.5rem;
  top: 0.5rem;
  width: calc(100% - 1rem);
  height: calc(100% - 1rem);
  border-radius: 0.5rem;
  display: flex;
  justify-content: center;
  align-items: center;
  container-type: size;
}

.lamp-circle {
  width: min(calc(100cqw - 0.8rem), calc(100cqh - 0.8rem));
  height: min(calc(100cqw - 0.8rem), calc(100cqh - 0.8rem));
  aspect-ratio: 1 / 1;
  border-radius: 999px;
}

.lamp-label {
  left: 0;
  width: 100%;
  z-index: 1;
  padding: 0.35rem;
  pointer-events: none;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
}
</style>
