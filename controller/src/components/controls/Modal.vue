<script setup lang=ts>
import { computed, inject } from 'vue'
import { shade } from 'polished'
import { Controls } from '@av-controls/protocol'

// vue
const props = defineProps({
  modal: {
    type: Object as () => Controls.Modal.Sender,
    required: true,
  },
})

const openModal = inject<(modal: Controls.Modal.Sender) => void>('openModal')

const color = computed(() => {
  const spec = props.modal.spec
  // Use a slightly different visual state if this modal is somehow "active" (optional)
  return spec.color
})

const basisStyle = computed(() => {
  const spec = props.modal.spec
  return {
    backgroundColor: color.value,
    boxShadow: `0 0 2rem -0.5rem ${spec.color}`,
    borderColor: spec.color,
  }
})

function activate(e: Event) {
  if (openModal) {
    openModal(props.modal)
  }
  props.modal.onTouch()
  e.preventDefault()
}

</script>

<template>
  <div
    class="basis"
    :style=basisStyle
    @touchstart="activate"
    @mousedown="activate"
    >
    <!-- Icon or indicator that this is a modal? -->
    <div class="modal-indicator">⇱</div>
  </div>
  <div class="centered-label" >
    {{ props.modal.spec.name }}
  </div>
</template>

<style scoped>
@import './control-styles.css';

.modal-indicator {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  color: #fff8;
  font-size: 1.2rem;
}
</style>
