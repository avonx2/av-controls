<script setup lang=ts>
import { computed, onBeforeUnmount, ref  } from 'vue'
import { Controls } from 'av-controls'



// for color manipulation
import { shade } from 'polished'

// vue
const props = defineProps({
  knob: {
    type: Object as () => Controls.Knob.Sender,
    required: true,
  },
})

const currentValue = computed(() => props.knob.value)

const normalizedValue = computed(() => props.knob.getNormValue())

const formattedValue = computed(() => {
  return currentValue.value.toFixed(props.knob.spec.decimalPlaces)
})

const backgroundStyle = computed(() => {
  const color = props.knob.spec.color
  return {
    backgroundColor: shade(0.2, color),
    borderColor: shade(0.2, color),
    boxShadow: `0 0 3rem -2rem ${color}`
  }
})

const darkenedColor = computed(() => shade(0.4, props.knob.spec.color))

const arcPoint = computed(() => {
  const angle = 2 * Math.PI * (normalizedValue.value - 0.25)
  const x = 50 + 50 * Math.cos(angle)
  const y = 50 + 50 * Math.sin(angle)
  return `${x},${y}`
})

const largeArc = computed(() => {
  return normalizedValue.value > 0.5 ? 1 : 0
})

let centerX = 0 
let centerY = 0
let touchId: null | number = null

const control = ref<HTMLDivElement | null>(null)

function touchstart(e: TouchEvent) {
  const div = e.currentTarget as HTMLDivElement
  const rect = div.getBoundingClientRect()
  centerX = rect.left + rect.width / 2
  centerY = rect.top + rect.height / 2
  window.addEventListener('touchmove', touchmove)
  window.addEventListener('touchend', endTouchDrag)
  e.preventDefault()
  control.value!.focus()
}

function touchmove(e: TouchEvent) {
  if(touchId !== null) {
    for(let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i]
      if (touch && touch.identifier == touchId) {
        updateValue(touch.clientX, touch.clientY)
      }
    }
  }
}

function endTouchDrag() {
  touchId = null
  window.removeEventListener('touchmove', touchmove)
  window.removeEventListener('touchend', endTouchDrag)
}

function onMousedown(e: MouseEvent) {
  const div = e.currentTarget as HTMLDivElement
  const rect = div.getBoundingClientRect()
  centerX = rect.left + rect.width / 2
  centerY = rect.top + rect.height / 2
  updateValue(e.clientX, e.clientY)
  window.addEventListener('mousemove', mousemove)
  window.addEventListener('mouseup', endMousedown)
  control.value!.focus()
}

function mousemove(e: MouseEvent) {
  updateValue(e.clientX, e.clientY)
}

function endMousedown() {
  window.removeEventListener('mousemove', mousemove)
  window.removeEventListener('mouseup', endMousedown)
}

onBeforeUnmount(() => {
  endMousedown()
  endTouchDrag()
})

function updateValue(x: number, y: number) : void  {
  const vx = centerX - x
  const vy = centerY - y 
  // calculate angle
  const angle = Math.PI - Math.atan2(-vx, -vy) 
  props.knob.onTouch()
  props.knob.setNormValue(angle / (Math.PI * 2))
}

function keyPress(e: KeyboardEvent) {
  let v = props.knob.getNormValue()
  if (e.key === 'ArrowUp' || e.key === 'k') {
    v -= 0.05
  } else if (e.key === 'ArrowDown' || e.key === 'j') {
    v += 0.05
  }
  if (v < 0) {
    v += 1
  } else if (v > 1) {
    v -= 1
  }
  props.knob.setNormValue(v)
}

</script>

<template>
  <div
    ref="control" :tabindex="props.knob.tabIndex()"
    class="basis"
    :style=backgroundStyle
    @touchstart="touchstart"
    @mousedown="onMousedown"
    @keydown="keyPress"
    >
    <div class="svg-container">
      <svg class="schematic" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="50" :fill="darkenedColor" />
        <path :d="`M50,50 L50,0 A50,50 0 ${largeArc},1 ${arcPoint} Z`" :fill="props.knob.spec.color" />
      </svg>
    </div>

  </div>
  <div class="label-top">
    {{ formattedValue }}
  </div>
  <div class="label-bottom">
    {{ props.knob.spec.name }}
  </div>
</template>

<style scoped>
@import './control-styles.css';

.svg-container {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
}

.meter {
  position: absolute;
  width: 100%;
  pointer-events: none;
  border-bottom-right-radius: 0.5rem;
  user-select: none;
}

</style>
