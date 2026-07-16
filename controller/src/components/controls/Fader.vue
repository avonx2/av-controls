<script setup lang=ts>
import { computed, onBeforeUnmount, ref  } from 'vue'
import { Controls } from '@av-controls/protocol'

// for color manipulation
import { shade } from 'polished'

// vue
const props = defineProps({
  fader: {
    type: Object as () => Controls.Fader.Sender,
    required: true,
  },
})

const currentValue = computed(() => props.fader.value)
const isHorizontal = computed(() => props.fader.spec.isHorizontal)

const formattedValue = computed(() => {
  return currentValue.value.toFixed(props.fader.spec.decimalPlaces)
})

const normalizedValue = computed(() => {
  return props.fader.getNormValue()
})

const backgroundStyle = computed(() => {
  const color = props.fader.spec.color || '#222'
  try {
    return {
      backgroundColor: shade(0.3, color),
      borderColor: color,
      boxShadow: `0 0 3rem -2rem ${color}`
    }
  } catch (e) {
    // Fallback if shade fails (e.g. invalid color string)
    return {
      backgroundColor: '#1a1a1a',
      borderColor: '#333',
    }
  }
})

const meterStyle = computed(() => {
  if (isHorizontal.value) {
    return {
      width: `${(normalizedValue.value ?? 0.5) * 100}%`,
      height: '100%',
      left: 0, 
      backgroundColor: props.fader.spec.color
    }
  } else {
    return {
      height: `${(normalizedValue.value ?? 0.5) * 100}%`,
      width: '100%',
      bottom: 0, 
      backgroundColor: props.fader.spec.color
    }
  }
})

let rect: DOMRect | null = null
let touchId: null | number = null

const control = ref<HTMLDivElement | null>(null)

function updateValue(clientPos: number) : void  {
  if (!rect) return;

  let v: number;
  if (isHorizontal.value) {
    const x = clientPos - rect.left;
    v = x / rect.width;
  } else {
    const y = rect.bottom - clientPos;
    v = y / rect.height;
  }
  
  const clamped = Math.max(0, Math.min(1, v))
  props.fader.onTouch()
  props.fader.setNormValue(clamped)
}

function touchstart(e: TouchEvent) {
  const touch = e.changedTouches[0]
  if (touch) {
    const div = e.currentTarget as HTMLDivElement
    rect = div.getBoundingClientRect()
    touchId = touch.identifier
    updateValue(isHorizontal.value ? touch.clientX : touch.clientY)
    window.addEventListener('touchmove', touchmove)
    window.addEventListener('touchend', endTouchDrag)
    e.preventDefault()
    control.value!.focus()
  }
}

function touchmove(e: TouchEvent) {
  if(touchId !== null) {
    for(let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i]
      if (touch && touch.identifier == touchId) {
        updateValue(isHorizontal.value ? touch.clientX : touch.clientY)
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
  rect = div.getBoundingClientRect()
  updateValue(isHorizontal.value ? e.clientX : e.clientY)
  window.addEventListener('mousemove', mousemove)
  window.addEventListener('mouseup', endMousedown)
  control.value!.focus()
}

function mousemove(e: MouseEvent) {
  updateValue(isHorizontal.value ? e.clientX : e.clientY)
}

function endMousedown() {
  window.removeEventListener('mousemove', mousemove)
  window.removeEventListener('mouseup', endMousedown)
}

onBeforeUnmount(() => {
  endMousedown()
  endTouchDrag()
})

function keyPress(e: KeyboardEvent) {
  let v = props.fader.getNormValue()
  if (isHorizontal.value) {
    if (e.key === 'ArrowRight' || e.key === 'l') {
      v += 0.05
    } else if (e.key === 'ArrowLeft' || e.key === 'h') {
      v -= 0.05
    }
  } else {
    if (e.key === 'ArrowUp' || e.key === 'k') {
      v += 0.05
    } else if (e.key === 'ArrowDown' || e.key === 'j') {
      v -= 0.05
    }
  }
  const clamped = Math.max(0, Math.min(1, v))
  props.fader.setNormValue(clamped)
}

</script>

<template>
  <div
    ref="control" :tabindex="props.fader.tabIndex()"
    class="basis fader-basis"
    :class="{ 'fader-horizontal': isHorizontal, 'fader-vertical': !isHorizontal }"
    :style=backgroundStyle
    @touchstart="touchstart"
    @mousedown="onMousedown"
    @keydown="keyPress"
    >
    <div class="meter" :style=meterStyle>
    </div>
  </div>
  <div class="label-top" :class="{ 'label-left': isHorizontal }">
    {{ formattedValue }}
  </div>
  <div class="label-bottom" :class="{ 'label-right': isHorizontal }">
    {{ props.fader.spec.name }}
  </div>
</template>

<style scoped>
@import './control-styles.css';

.fader-basis{
  border: none; 
  border-left: 0.5rem solid #000;
}

.fader-horizontal {
  border-left: none;
  border-bottom: 0.5rem solid #000;
}

.meter {
  position: absolute;
  pointer-events: none;
  user-select: none;
}

.fader-vertical .meter {
  width: 100%;
  bottom: 0; 
  border-bottom-right-radius: 0.5rem;
  border-bottom-left-radius: 0.5rem;
}

.fader-horizontal .meter {
  height: 100%;
  left: 0;
  border-top-right-radius: 0.5rem;
  border-bottom-right-radius: 0.5rem;
}

.label-left {
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  text-align: left;
  width: auto;
  padding-left: 0.6rem;
  padding-right: 0.6rem;
}

.label-right {
  top: 50%;
  right: 0;
  transform: translateY(-50%);
  text-align: right;
  width: auto;
  padding-left: 0.6rem;
  padding-right: 0.6rem;
}
</style>
