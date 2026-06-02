<script setup lang=ts>
import { computed, onBeforeUnmount, ref } from 'vue'

import { Controls } from '@av-controls/protocol'


// for color manipulation
import { shade } from 'polished'

// vue
const props = defineProps({
  dots: {
    type: Object as () => Controls.Dots.Sender,
    required: true,
  },
})

const backgroundStyle = computed(() => {
  const color = props.dots.spec.color
  return {
    backgroundColor: shade(0.3, color),
    borderColor: color,
    boxShadow: `0 0 3rem -2rem ${color}`
  }
})

const control = ref<HTMLDivElement | null>(null)

let indexOfDotBeingMoved: number | null = null
let dragOrigin: null | Controls.Dots.Dot = null
let originalDotValue: null | Controls.Dots.Dot = null
let touchId: number | null = null

function mouseDrag(index: number, e: MouseEvent) {
  window.addEventListener('mousemove', mousemove)
  window.addEventListener('mouseup', endMouseDrag)
  startDrag(index, e.clientX, e.clientY)
  e.preventDefault()
  control.value!.focus()
}

function touchDrag(index: number, e: TouchEvent) {
  const touch = e.changedTouches[0]
  if (touch) {
    window.addEventListener('touchmove', touchmove)
    window.addEventListener('touchend', endTouchDrag)
    touchId = touch.identifier
    startDrag(index, touch.clientX, touch.clientY)
    e.preventDefault()
  }
}

let width = 1
let height = 1
function startDrag(i: number, x: number, y: number) {
  const dotValue = props.dots.values[i]
  if (dotValue) {
    indexOfDotBeingMoved = i
    dragOrigin = [x, y]
    originalDotValue = dotValue
    width = control.value!.clientWidth
    height = control.value!.clientHeight
  }
} 

function mousemove(e: MouseEvent) {
  move(e.clientX, e.clientY)
}

function touchmove(e: TouchEvent) {
  if(touchId !== null) {
    for(let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i]
      if (touch && touch.identifier == touchId) {
        move(touch.clientX, touch.clientY)
      }
    }
  }
}

const currentPosition = ref<Controls.Dots.Dot | null>(null)
function move(x: number, y: number) {
  if(
    originalDotValue !== null &&
    indexOfDotBeingMoved !== null &&
    dragOrigin !== null
  ) {
    const newValues = [
      originalDotValue[0] + (x - dragOrigin[0]) / width,
      originalDotValue[1] - (y - dragOrigin[1]) / height
    ] as Controls.Dots.Dot
    for(const c of [0, 1] as const) {
      if(newValues[c] < 0) {
        newValues[c] = 0
      }
      if(newValues[c] > 1) {
        newValues[c] = 1
      }
      const padding = [props.dots.spec.xPadding, props.dots.spec.yPadding][c] || 0
      if(indexOfDotBeingMoved > 0) {
        const prevDot = props.dots.values[indexOfDotBeingMoved - 1]
        if (prevDot) {
          const lowerLimit = prevDot[c] + padding
          if(newValues[c] < lowerLimit) {
            newValues[c] = lowerLimit
          }
        }
      }
      if(indexOfDotBeingMoved < props.dots.values.length - 1) {
        const nextDot = props.dots.values[indexOfDotBeingMoved + 1]
        if (nextDot) {
          const upperLimit = nextDot[c] - padding
          if(newValues[c] > upperLimit) {
            newValues[c] = upperLimit
          }
        }
      }
    }
    currentPosition.value = newValues
    props.dots.moveDot(indexOfDotBeingMoved!, newValues)
  }
}

function endMouseDrag() {
  window.removeEventListener('mousemove', mousemove)
  window.removeEventListener('mouseup', endMouseDrag)
  endDrag()
}

function endTouchDrag() {
  touchId = null
  window.removeEventListener('touchmove', touchmove)
  window.removeEventListener('touchend', endTouchDrag)
  endDrag()
}

function endDrag() {
  indexOfDotBeingMoved = null
  currentPosition.value = null
}

onBeforeUnmount(() => {
  endMouseDrag()
  endTouchDrag()
})


</script>

<template>
  <div
    ref="control" :tabindex="props.dots.tabIndex()"
    class="basis dots-basis"
    :style=backgroundStyle
    >
    <div class="dot-container">
      <div v-for="(point, index) in dots.values" :key="index" 
          class="dot" 
          :style="{ left: `${point[0] * 100}%`, bottom: `${point[1] * 100}%` }"
          @mousedown="mouseDrag(index, $event)"
          @touchstart="touchDrag(index, $event)"
      ></div>
    </div>
  </div>
  <div class="label-top" v-if="currentPosition !== null">
    {{ `${currentPosition[0].toFixed(2)}, ${currentPosition[1].toFixed(2)}` }}
  </div>
  <div class="label-bottom">
    {{ props.dots.spec.name }}
  </div>
</template>

<style scoped>
@import './control-styles.css';

.dots-basis {
  border: none;
}

/* define dot size, were in vue scoped */

.dot-container {
  position: relative;
  left: 1.5rem; 
  top: 1.5rem;
  height: calc(100% - 3rem);
  width: calc(100% - 3rem);
}

.dot {
  position: absolute;
  width: 3rem;
  height: 3rem;
  background-color: #fffb;
  border-radius: 50%;
  cursor: move;
  transform: translate(-50%, 50%);
}

</style>
