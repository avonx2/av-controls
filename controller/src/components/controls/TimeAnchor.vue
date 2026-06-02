<script setup lang="ts">
import { ref, computed } from 'vue'
import { shade } from 'polished'
import { Controls } from '@av-controls/protocol'

const props = defineProps({
  timeAnchor: {
    type: Object as () => Controls.TimeAnchor.Sender,
    required: true
  }
})

const active = ref(false)

const color = computed(() => {
  const spec = props.timeAnchor.spec
  if (active.value) {
    return shade(0.35, spec.color)
  } else {
    return spec.color
  }
})

const basisStyle = computed(() => {
  const spec = props.timeAnchor.spec
  return {
    backgroundColor: color.value,
    boxShadow: `0 0 2rem -0.5rem ${spec.color}`,
    borderColor: spec.color,
  }
})

function touchstart(e: Event) {
  props.timeAnchor.onTouch();
  active.value = true;
  props.timeAnchor.setToNow();
  
  // Add visual feedback timeout
  setTimeout(() => {
    active.value = false
  }, 150)
  
  ;(e.currentTarget as HTMLDivElement).focus()
  e.preventDefault()
}

function touchend() {
  // We keep it active for the 150ms timeout to ensure visual feedback even on quick taps
}

</script>

<template>
  <div
    class="basis"
    :style="basisStyle"
    :tabindex="props.timeAnchor.tabIndex()"
    @touchstart="touchstart"
    @mousedown="touchstart"
    @keydown.enter="touchstart"
    @keydown.space="touchstart"
    @keyup="touchend"
    @touchend="touchend"
    @mouseup="touchend"
  >
  </div>
  <div class="centered-label">
    {{ props.timeAnchor.spec.name }}
    <span v-if="timeAnchor.time !== null"><br/>{{ timeAnchor.time.toFixed(2) }}s</span>
  </div>
</template>

<style scoped>
@import './control-styles.css';

.centered-label {
  pointer-events: none;
  text-align: center;
}
</style>
