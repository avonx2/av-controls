<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'

const props = defineProps<{
  initialTime: number
  initialValue?: number
  showValue: boolean
  x: number
  y: number
}>()

const emit = defineEmits<{
  save: [time: number, value?: number]
  cancel: []
}>()

const timeInput = ref(props.initialTime.toFixed(3))
const valueInput = ref(props.initialValue !== undefined ? props.initialValue.toFixed(3) : '')
const timeRef = ref<HTMLInputElement | null>(null)

onMounted(() => {
  nextTick(() => {
    timeRef.value?.focus()
    timeRef.value?.select()
  })
})

function save() {
  const t = parseFloat(timeInput.value)
  if (isNaN(t)) return
  if (props.showValue) {
    const v = parseFloat(valueInput.value)
    if (isNaN(v)) return
    emit('save', t, v)
  } else {
    emit('save', t)
  }
}

function cancel() {
  emit('cancel')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    save()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancel()
  }
}
</script>

<template>
  <div class="point-editor-overlay" @contextmenu.prevent="cancel" @pointerdown.self="cancel">
    <div class="point-editor-popup" :style="{ left: `${x}px`, top: `${y}px` }" @keydown="onKeydown">
      <div class="editor-row">
        <label>Time</label>
        <input ref="timeRef" type="text" v-model="timeInput" />
      </div>
      <div class="editor-row" v-if="showValue">
        <label>Value</label>
        <input type="text" v-model="valueInput" />
      </div>
      <div class="editor-actions">
        <button @click="save">Save</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.point-editor-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10000;
  pointer-events: auto;
}
.point-editor-popup {
  position: fixed;
  background: #2a2e35;
  border: 1px solid #4a545c;
  padding: 0.5rem;
  border-radius: 0.25rem;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  transform: translate(-50%, -100%);
  margin-top: -10px;
}
.editor-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}
.editor-row label {
  font-size: 0.75rem;
  color: #aaa;
}
.editor-row input {
  background: #1a1e25;
  border: 1px solid #3a444c;
  color: #fff;
  padding: 0.2rem 0.4rem;
  border-radius: 0.2rem;
  width: 80px;
  font-family: monospace;
}
.editor-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.2rem;
}
.editor-actions button {
  background: #3a444c;
  border: none;
  color: #fff;
  padding: 0.2rem 0.6rem;
  border-radius: 0.2rem;
  cursor: pointer;
  font-size: 0.75rem;
}
.editor-actions button:hover {
  background: #4a545c;
}
</style>
