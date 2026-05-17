<script setup lang="ts">
import { ref, computed } from 'vue'
import { Controls } from 'av-controls'

const props = defineProps({
  timeAnchor: {
    type: Object as () => Controls.TimeAnchor.Sender,
    required: true
  }
})

const spec = computed(() => props.timeAnchor.spec)
const active = ref(false)

function onPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'mouse' || e.button === 0) {
    active.value = true
    props.timeAnchor.setToNow()
    
    // Add visual feedback timeout
    setTimeout(() => {
      active.value = false
    }, 150)
  }
}

// Ensure visual state is reset if pointer leaves/cancels (though the timeout usually handles it)
function onPointerUpOrCancel() {
  // We keep it active for the 150ms timeout to ensure visual feedback even on quick taps
}
</script>

<template>
  <div 
    class="time-anchor-control" 
    :class="{ active }"
    :style="`background-color: ${spec.color}`"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUpOrCancel"
    @pointercancel="onPointerUpOrCancel"
    @pointerleave="onPointerUpOrCancel"
  >
    <div class="time-anchor-label">{{ spec.name }}</div>
    <div class="time-anchor-value" v-if="timeAnchor.time !== null">
      {{ timeAnchor.time.toFixed(2) }}s
    </div>
  </div>
</template>

<style scoped>
.time-anchor-control {
  width: 100%;
  height: 100%;
  border-radius: 0.5rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1), 0 4px 6px rgba(0, 0, 0, 0.3);
  transition: transform 0.05s ease, filter 0.05s ease, box-shadow 0.05s ease;
  position: relative;
  overflow: hidden;
}

.time-anchor-control.active {
  transform: scale(0.95);
  filter: brightness(1.3);
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.4), 0 1px 2px rgba(0, 0, 0, 0.5);
}

.time-anchor-label {
  font-weight: 600;
  font-size: 0.9rem;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  pointer-events: none;
}

.time-anchor-value {
  font-family: monospace;
  font-size: 0.75rem;
  opacity: 0.8;
  margin-top: 0.2rem;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  pointer-events: none;
}

.time-anchor-control::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(to bottom, rgba(255,255,255,0.15) 0%, rgba(0,0,0,0.15) 100%);
  pointer-events: none;
}
</style>