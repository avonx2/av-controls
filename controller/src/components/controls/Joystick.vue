<script setup lang="ts">
import { computed, onBeforeUnmount, ref  } from 'vue'
import { Controls } from '@av-controls/protocol'



// for color manipulation
import { shade } from 'polished'

// vue
const props = defineProps({
  joystick: {
    type: Object as () => Controls.Joystick.Sender,
    required: true,
  },
})

const currentX = computed(() => props.joystick.x)
const currentY = computed(() => props.joystick.y)

const formattedValue = computed(() => {
  const x = currentX.value.toFixed(2)
  const y = currentY.value.toFixed(2)
  return `${x}, ${y}`
})

const backgroundStyle = computed(() => {
  const color = props.joystick.spec.color
  return {
    backgroundColor: shade(0.3, color),
    borderColor: color,
    boxShadow: `0 0 3rem -2rem ${color}`
  }
})

// Circle positioning - use computed size for perfect circles
const circleStyle = computed(() => {
  // Position as percentage of container, with 25% max movement in each direction
  const leftPercent = 50 + (currentX.value * 50) // 50% center + movement
  const topPercent = 50 - (currentY.value * 50)  // 50% center - movement (Y inverted)

  return {
    width: `${size.value}px`,
    height: `${size.value}px`,
    backgroundColor: props.joystick.spec.color,
    borderRadius: '50%',
    position: 'absolute' as const,
    pointerEvents: 'none' as const,
    left: `${leftPercent}%`,
    top: `${topPercent}%`,
    transform: 'translate(-50%, -50%)', // Center the circle on the calculated position
    transition: isDragging.value ? 'none' : 'all 0.1s ease-out'
  }
})

let rect: DOMRect | null = null
let touchId: null | number = null
let startX = 0
let startY = 0
const isDragging = ref(false)

const control = ref<HTMLDivElement | null>(null)

// Calculate circle size based on container dimensions
const size = computed(() => {
  if (!control.value) return 0
  const minDim = Math.min(control.value.clientWidth, control.value.clientHeight)
  return minDim * 0.5 // Diameter = 50%, so radius = 25%
})

function touchstart(e: TouchEvent) {
  const touch = e.changedTouches[0]
  if (touch) {
    const div = e.currentTarget as HTMLDivElement
    rect = div.getBoundingClientRect()
    touchId = touch.identifier
    startX = touch.clientX
    startY = touch.clientY
    isDragging.value = true

    window.addEventListener('touchmove', touchmove)
    window.addEventListener('touchend', endTouchDrag)
    window.addEventListener('touchcancel', endTouchDrag)
    e.preventDefault()
    control.value!.focus()
  }
}

function touchmove(e: TouchEvent) {
  if(touchId !== null) {
    for(let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i]
      if (touch && touch.identifier == touchId) {
        updatePosition(touch.clientX, touch.clientY)
      }
    }
  }
}

function endTouchDrag() {
  touchId = null
  isDragging.value = false
  props.joystick.reset()
  window.removeEventListener('touchmove', touchmove)
  window.removeEventListener('touchend', endTouchDrag)
  window.removeEventListener('touchcancel', endTouchDrag)
}

function onMousedown(e: MouseEvent) {
  const div = e.currentTarget as HTMLDivElement
  rect = div.getBoundingClientRect()
  startX = e.clientX
  startY = e.clientY
  isDragging.value = true

  window.addEventListener('mousemove', mousemove)
  window.addEventListener('mouseup', endMousedown)
  control.value!.focus()
}

function mousemove(e: MouseEvent) {
  updatePosition(e.clientX, e.clientY)
}

function endMousedown() {
  isDragging.value = false
  props.joystick.reset()
  window.removeEventListener('mousemove', mousemove)
  window.removeEventListener('mouseup', endMousedown)
}

onBeforeUnmount(() => {
  endMousedown()
  endTouchDrag()
})

function updatePosition(clientX: number, clientY: number): void {
  if (!rect) return

  // Calculate delta from start position
  const deltaX = clientX - startX
  const deltaY = clientY - startY

  const normalizedX = deltaX * 2 / rect.width
  const normalizedY = -deltaY * 2 / rect.height

  // No clamping - let screen bounds handle limits
  props.joystick.onTouch()
  props.joystick.setPosition(normalizedX, normalizedY)
}

function keyPress(e: KeyboardEvent) {
  let x = props.joystick.x
  let y = props.joystick.y
  const step = 0.1

  if (e.key === 'ArrowLeft' || e.key === 'h') {
    x -= step
  } else if (e.key === 'ArrowRight' || e.key === 'l') {
    x += step
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    y += step
  } else if (e.key === 'ArrowDown' || e.key === 'j') {
    y -= step
  } else if (e.key === ' ' || e.key === 'Escape') {
    x = 0
    y = 0
  }

  props.joystick.setPosition(x, y)
}

</script>

<template>
  <div
    ref="control" :tabindex="props.joystick.tabIndex()"
    class="basis joystick-basis"
    :style="backgroundStyle"
    @touchstart="touchstart"
    @mousedown="onMousedown"
    @keydown="keyPress"
    >
    <div class="circle" :style="circleStyle">
    </div>
  </div>
  <div class="label-top">
    {{ formattedValue }}
  </div>
  <div class="label-bottom">
    {{ props.joystick.spec.name }}
  </div>
</template>

<style scoped>
@import './control-styles.css';

.joystick-basis {
  border: none;
  border: 0.5rem solid #000;
}

.circle {
  user-select: none;
}

</style>
