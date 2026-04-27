<script setup lang="ts">
import { computed } from 'vue'
import { shade, transparentize } from 'polished'
import { Controls } from 'av-controls'

const props = defineProps({
  meter: {
    type: Object as () => Controls.Meter.Sender,
    required: true,
  },
})

const darkenedColor = computed(() => {
  return shade(0.35, props.meter.spec.color)
})

const percentage = computed(() => {
  const range = props.meter.spec.max - props.meter.spec.min
  if (range === 0) return 0
  return Math.max(0, Math.min(1, (props.meter.value - props.meter.spec.min) / range))
})

const containerStyle = computed(() => {
  return {
    backgroundColor: transparentize(0.8, props.meter.spec.color),
  }
})

const fillStyle = computed(() => {
  return {
    backgroundColor: props.meter.spec.color,
    height: `${percentage.value * 100}%`,
  }
})

const trackStyle = computed(() => {
  return {
    backgroundColor: darkenedColor.value,
  }
})
</script>

<template>
  <div class="container" :style="containerStyle">
    <div class="track" :style="trackStyle">
      <div class="fill" :style="fillStyle"></div>
    </div>
  </div>
  <div class="label-top">{{ props.meter.spec.name }}</div>
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
  align-items: flex-end;
  padding: 0.5rem;
}

.track {
  width: 60%;
  height: 100%;
  border-radius: 0.25rem;
  position: relative;
  overflow: hidden;
}

.fill {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  border-radius: 0.25rem;
  transition: height 0.05s ease-out;
}
</style>
