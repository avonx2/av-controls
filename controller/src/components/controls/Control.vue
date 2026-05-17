<script setup lang=ts>

import { ref, computed, inject, onMounted, onBeforeUnmount, watch, type Ref } from 'vue'

import { Controls } from 'av-controls'
import type { InputMappings } from '../../input-mappings'

import FaderComponent from './Fader.vue'
import PadComponent from './Pad.vue'
import SwitchComponent from './Switch.vue'
import SelectorComponent from './Selector.vue'
import ConfirmButtonComponent from './ConfirmButton.vue'
import LabelComponent from './Label.vue'
import ConfirmSwitchComponent from './ConfirmSwitch.vue'
import CakeComponent from './Cake.vue'
import PresetButtonComponent from './PresetButton.vue'
import TimeAnchorComponent from './TimeAnchor.vue'
import LetterboxComponent from './Letterbox.vue'
import TextboxComponent from './Textbox.vue'
import DotsComponent from './Dots.vue'
import KnobComponent from './Knob.vue'
import JoystickComponent from './Joystick.vue'
import LampComponent from './Lamp.vue'
import MeterComponent from './Meter.vue'
import ModalComponent from './Modal.vue'
import MenuControlComponent from './MenuControl.vue'
import Player3DComponent from './Player3D.vue'

import TabsComponent from './Tabs.vue'
import FramedGroupComponent from './Group.vue'

const props = defineProps({
  control: {
    type: Object as () => Controls.Base.Sender,
    required: true,
  },
})

const inputMappings = inject<Ref<InputMappings | undefined>>('inputMappings')
const layoutEditMode = inject<Ref<boolean>>('layoutEditMode', ref(false))
const layoutEditConfig = inject('layoutEditConfig', {
  snapToControls: true,
  logSnapping: false,
})
const openControlEditor = inject<(control: Controls.Base.Sender) => void>('openControlEditor')

const type = computed(() => props.control.spec.type)
const isContainerControl = computed(() =>
  type.value === 'group' || type.value === 'tabs' || type.value === 'modal'
)

const layoutX = ref(props.control.spec.x)
const layoutY = ref(props.control.spec.y)
const layoutW = ref(props.control.spec.width)
const layoutH = ref(props.control.spec.height)

watch(
  () => [props.control, props.control.spec.x, props.control.spec.y, props.control.spec.width, props.control.spec.height],
  () => {
    layoutX.value = props.control.spec.x
    layoutY.value = props.control.spec.y
    layoutW.value = props.control.spec.width
    layoutH.value = props.control.spec.height
  },
)

const posize = computed(() => {
  return {
    width: `${layoutW.value}%`,
    height: `${layoutH.value}%`,
    top: `${layoutY.value}%`,
    left: `${layoutX.value}%`,
  }
})

const controlElement = ref<HTMLElement | null>(null)
let pointerMoveListener: ((event: PointerEvent) => void) | null = null
let pointerUpListener: ((event: PointerEvent) => void) | null = null
let snapOverlayEl: HTMLElement | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeLayoutValue(value: number): number {
  const rounded = Math.round(value * 1000) / 1000
  const nearestInt = Math.round(rounded)
  if (Math.abs(rounded - nearestInt) <= 0.0015) {
    return nearestInt
  }
  return rounded
}

function updateSpecFromLayout() {
  props.control.spec.x = layoutX.value
  props.control.spec.y = layoutY.value
  props.control.spec.width = layoutW.value
  props.control.spec.height = layoutH.value
}

function commitLayout() {
  layoutX.value = normalizeLayoutValue(layoutX.value)
  layoutY.value = normalizeLayoutValue(layoutY.value)
  layoutW.value = normalizeLayoutValue(layoutW.value)
  layoutH.value = normalizeLayoutValue(layoutH.value)
  updateSpecFromLayout()
}

function getSiblingEdgeLines(): { x: number[]; y: number[] } {
  const xLines: number[] = [0, 100]
  const yLines: number[] = [0, 100]

  const parent = props.control.parent as (Controls.Base.Sender & {
    senders?: Record<string, Controls.Base.Sender>
  }) | undefined
  const siblings = parent?.senders ? Object.values(parent.senders) : []

  for (const sibling of siblings) {
    if (!sibling || sibling === props.control) continue

    xLines.push(sibling.spec.x, sibling.spec.x + sibling.spec.width)
    yLines.push(sibling.spec.y, sibling.spec.y + sibling.spec.height)
  }

  const uniqSorted = (values: number[]) => {
    values.sort((a, b) => a - b)
    const out: number[] = []
    for (const v of values) {
      const normalized = normalizeLayoutValue(v)
      if (out.length === 0 || Math.abs(out[out.length - 1]! - normalized) > 0.001) {
        out.push(normalized)
      }
    }
    return out
  }

  return {
    x: uniqSorted(xLines),
    y: uniqSorted(yLines),
  }
}

function findNearestLine(value: number, lines: number[], threshold = 2): { value: number; dist: number } | null {
  let best: { value: number; dist: number } | null = null
  for (const line of lines) {
    const d = Math.abs(line - value)
    if (d <= threshold && (!best || d < best.dist)) {
      best = { value: line, dist: d }
    }
  }
  return best
}

function logSnap(message: string, payload: Record<string, unknown>) {
  if (layoutEditConfig.logSnapping) {
    console.info(`[layout-snap] ${message}`, payload)
  }
}

function clearSnapOverlay() {
  if (snapOverlayEl?.parentElement) {
    snapOverlayEl.parentElement.removeChild(snapOverlayEl)
  }
  snapOverlayEl = null
}

function renderSnapOverlay(parent: HTMLElement, lines: { x: number[]; y: number[] }) {
  clearSnapOverlay()
  const overlay = document.createElement('div')
  overlay.style.position = 'absolute'
  overlay.style.left = '0'
  overlay.style.top = '0'
  overlay.style.width = '100%'
  overlay.style.height = '100%'
  overlay.style.pointerEvents = 'none'
  overlay.style.boxSizing = 'border-box'

  for (const x of lines.x) {
    const line = document.createElement('div')
    line.style.position = 'absolute'
    line.style.left = `${x}%`
    line.style.top = '0'
    line.style.width = '1px'
    line.style.height = '100%'
    line.style.background = 'rgba(90, 210, 255, 0.35)'
    overlay.appendChild(line)
  }
  for (const y of lines.y) {
    const line = document.createElement('div')
    line.style.position = 'absolute'
    line.style.left = '0'
    line.style.top = `${y}%`
    line.style.width = '100%'
    line.style.height = '1px'
    line.style.background = 'rgba(90, 210, 255, 0.35)'
    overlay.appendChild(line)
  }

  parent.appendChild(overlay)
  snapOverlayEl = overlay
}

function beginPointerOperation(
  event: PointerEvent,
  mode:
    | 'move'
    | 'resize-left'
    | 'resize-right'
    | 'resize-top'
    | 'resize-bottom'
    | 'resize-top-left'
    | 'resize-top-right'
    | 'resize-bottom-left'
    | 'resize-bottom-right'
) {
  if (!layoutEditMode.value || event.button !== 0 || !controlElement.value) {
    return
  }
  event.preventDefault()
  event.stopPropagation()

  const element = controlElement.value
  const parent =
    (element.offsetParent as HTMLElement | null) ??
    (element.parentElement as HTMLElement | null)
  if (!parent) {
    return
  }

  let rect = parent.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    const positionedAncestor = element.closest('.control') as HTMLElement | null
    if (positionedAncestor && positionedAncestor !== element) {
      rect = positionedAncestor.getBoundingClientRect()
    }
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return
  }

  const startX = event.clientX
  const startY = event.clientY
  let didDrag = false
  const initialX = layoutX.value
  const initialY = layoutY.value
  const initialW = layoutW.value
  const initialH = layoutH.value
  const initialRight = initialX + initialW
  const initialBottom = initialY + initialH
  const minW = 1
  const minH = 1
  const snapLines = layoutEditConfig.snapToControls
    ? getSiblingEdgeLines()
    : { x: [], y: [] }
  if (layoutEditConfig.snapToControls) {
    renderSnapOverlay(parent, snapLines)
  }
  logSnap('start', {
    mode,
    control: props.control.spec.name,
    snapToControls: layoutEditConfig.snapToControls,
    xLines: snapLines.x,
    yLines: snapLines.y,
  })

  pointerMoveListener = (moveEvent: PointerEvent) => {
    moveEvent.preventDefault()
    if (!didDrag && (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3)) {
      didDrag = true
    }
    const dxPct = ((moveEvent.clientX - startX) / rect.width) * 100
    const dyPct = ((moveEvent.clientY - startY) / rect.height) * 100
    const snappingEnabled = layoutEditConfig.snapToControls && !moveEvent.shiftKey

    if (mode === 'move') {
      let nextX = clamp(initialX + dxPct, 0, 100 - layoutW.value)
      let nextY = clamp(initialY + dyPct, 0, 100 - layoutH.value)
      if (snappingEnabled) {
        const leftHit = findNearestLine(nextX, snapLines.x)
        const rightHit = findNearestLine(nextX + layoutW.value, snapLines.x)
        if (leftHit || rightHit) {
          const leftDelta = leftHit ? leftHit.value - nextX : Infinity
          const rightDelta = rightHit ? rightHit.value - (nextX + layoutW.value) : Infinity
          const useLeft = Math.abs(leftDelta) <= Math.abs(rightDelta)
          nextX = clamp(nextX + (useLeft ? leftDelta : rightDelta), 0, 100 - layoutW.value)
        }

        const topHit = findNearestLine(nextY, snapLines.y)
        const bottomHit = findNearestLine(nextY + layoutH.value, snapLines.y)
        if (topHit || bottomHit) {
          const topDelta = topHit ? topHit.value - nextY : Infinity
          const bottomDelta = bottomHit ? bottomHit.value - (nextY + layoutH.value) : Infinity
          const useTop = Math.abs(topDelta) <= Math.abs(bottomDelta)
          nextY = clamp(nextY + (useTop ? topDelta : bottomDelta), 0, 100 - layoutH.value)
        }
        logSnap('move', {
          control: props.control.spec.name,
          nextX,
          nextY,
          shiftBypass: moveEvent.shiftKey,
        })
      }
      layoutX.value = nextX
      layoutY.value = nextY
    } else {
      const changeLeft = mode === 'resize-left' || mode === 'resize-top-left' || mode === 'resize-bottom-left'
      const changeRight = mode === 'resize-right' || mode === 'resize-top-right' || mode === 'resize-bottom-right'
      const changeTop = mode === 'resize-top' || mode === 'resize-top-left' || mode === 'resize-top-right'
      const changeBottom = mode === 'resize-bottom' || mode === 'resize-bottom-left' || mode === 'resize-bottom-right'

      let nextLeft = initialX + (changeLeft ? dxPct : 0)
      let nextRight = initialRight + (changeRight ? dxPct : 0)
      let nextTop = initialY + (changeTop ? dyPct : 0)
      let nextBottom = initialBottom + (changeBottom ? dyPct : 0)

      if (changeLeft) nextLeft = clamp(nextLeft, 0, nextRight - minW)
      if (changeRight) nextRight = clamp(nextRight, nextLeft + minW, 100)
      if (changeTop) nextTop = clamp(nextTop, 0, nextBottom - minH)
      if (changeBottom) nextBottom = clamp(nextBottom, nextTop + minH, 100)

      if (snappingEnabled) {
        if (changeLeft) {
          const hit = findNearestLine(nextLeft, snapLines.x)
          if (hit) nextLeft = hit.value
        }
        if (changeRight) {
          const hit = findNearestLine(nextRight, snapLines.x)
          if (hit) nextRight = hit.value
        }
        if (changeTop) {
          const hit = findNearestLine(nextTop, snapLines.y)
          if (hit) nextTop = hit.value
        }
        if (changeBottom) {
          const hit = findNearestLine(nextBottom, snapLines.y)
          if (hit) nextBottom = hit.value
        }
      }

      if (changeLeft) nextLeft = clamp(nextLeft, 0, nextRight - minW)
      if (changeRight) nextRight = clamp(nextRight, nextLeft + minW, 100)
      if (changeTop) nextTop = clamp(nextTop, 0, nextBottom - minH)
      if (changeBottom) nextBottom = clamp(nextBottom, nextTop + minH, 100)

      layoutX.value = nextLeft
      layoutY.value = nextTop
      layoutW.value = nextRight - nextLeft
      layoutH.value = nextBottom - nextTop

      logSnap('resize', {
        control: props.control.spec.name,
        mode,
        shiftBypass: moveEvent.shiftKey,
        left: nextLeft,
        right: nextRight,
        top: nextTop,
        bottom: nextBottom,
      })
    }
    updateSpecFromLayout()
  }

  pointerUpListener = (upEvent: PointerEvent) => {
    upEvent.preventDefault()
    upEvent.stopPropagation()
    commitLayout()
    if (pointerMoveListener) {
      window.removeEventListener('pointermove', pointerMoveListener)
      pointerMoveListener = null
    }
    if (pointerUpListener) {
      window.removeEventListener('pointerup', pointerUpListener)
      pointerUpListener = null
    }
    clearSnapOverlay()
    if (mode === 'move' && !didDrag) {
      openControlEditor?.(props.control)
    }
  }

  window.addEventListener('pointermove', pointerMoveListener)
  window.addEventListener('pointerup', pointerUpListener)
}

function onMovePointerDown(event: PointerEvent) {
  if (!layoutEditMode.value) {
    return
  }
  beginPointerOperation(event, 'move')
}

function onResizeXPointerDown(event: PointerEvent) {
  beginPointerOperation(event, 'resize-right')
}

function onResizeYPointerDown(event: PointerEvent) {
  beginPointerOperation(event, 'resize-bottom')
}

function onResizeXYPointerDown(event: PointerEvent) {
  beginPointerOperation(event, 'resize-bottom-right')
}

function onResizeLeftPointerDown(event: PointerEvent) {
  beginPointerOperation(event, 'resize-left')
}

function onResizeTopPointerDown(event: PointerEvent) {
  beginPointerOperation(event, 'resize-top')
}

function onResizeTopLeftPointerDown(event: PointerEvent) {
  beginPointerOperation(event, 'resize-top-left')
}

function onResizeTopRightPointerDown(event: PointerEvent) {
  beginPointerOperation(event, 'resize-top-right')
}

function onResizeBottomLeftPointerDown(event: PointerEvent) {
  beginPointerOperation(event, 'resize-bottom-left')
}

const mappingCount = ref(0)

onMounted(() => {
  function onNewMappingCount(count: number) {
    mappingCount.value = count
    // Resubscribe for next change (one-shot pattern)
    inputMappings?.value?.waitForNextMappingCountChange(props.control, onNewMappingCount)
  }

  // Initial subscription
  if (inputMappings?.value) {
    mappingCount.value = inputMappings.value.waitForNextMappingCountChange(props.control, onNewMappingCount)
  }
})

onBeforeUnmount(() => {
  if (pointerMoveListener) {
    window.removeEventListener('pointermove', pointerMoveListener)
  }
  if (pointerUpListener) {
    window.removeEventListener('pointerup', pointerUpListener)
  }
  clearSnapOverlay()
})

const showlabels = false 
</script>

<template>
  <div
    ref="controlElement"
    class="control"
    :class="[type, { 'layout-edit-mode': layoutEditMode }]"
    :style="posize"
  >
    <div v-if='showlabels' class=typelabel>{{ type }}</div>

    <!-- Mapping indicators -->
    <div v-for="i in mappingCount" :key="i" :style="{left: (0.5 * (i - 1)) + 'rem'}" class="mapping-indicator"/>

    <FramedGroupComponent v-if="type === 'group'" :group="control as Controls.Group.Sender"/>
    <ModalComponent v-else-if="type === 'modal'" :modal="control as Controls.Modal.Sender"/>
    <TabsComponent v-else-if="type === 'tabs'" :tabs="control as Controls.Tabs.Sender"/>

    <PadComponent v-else-if="type === 'pad'" :pad="control as Controls.Pad.Sender"/>
    <FaderComponent v-else-if="type === 'fader'" :fader="control as Controls.Fader.Sender"/>
    <SwitchComponent v-else-if="type === 'switch'" :switch="control as Controls.Switch.Sender"/>
    <SelectorComponent v-else-if="type === 'selector'" :selector="control as Controls.Selector.Sender"/>
    <ConfirmButtonComponent v-else-if="type === 'confirm-button'" :confirmButton="control as Controls.ConfirmButton.Sender"/>
    <LabelComponent v-else-if="type === 'label'" :label="control as Controls.Label.Sender"/>
    <ConfirmSwitchComponent v-else-if="type === 'confirm-switch'" :confirmSwitch="control as Controls.ConfirmSwitch.Sender"/>
    <CakeComponent v-else-if="type === 'cake'" :cake="control as Controls.Cake.Sender"/>
    <PresetButtonComponent v-else-if="type === 'preset-button'" :presetButton="control as Controls.PresetButton.Sender"/>
    <TimeAnchorComponent v-else-if="type === 'time-anchor'" :timeAnchor="control as Controls.TimeAnchor.Sender"/>
    <LetterboxComponent v-else-if="type === 'letterbox'" :letterbox="control as Controls.Letterbox.Sender"/>
    <TextboxComponent v-else-if="type === 'textbox'" :textbox="control as Controls.Textbox.Sender"/>
    <DotsComponent v-else-if="type === 'dots'" :dots="control as Controls.Dots.Sender"/>
    <KnobComponent v-else-if="type === 'knob'" :knob="control as Controls.Knob.Sender"/>
    <JoystickComponent v-else-if="type === 'joystick'" :joystick="control as Controls.Joystick.Sender"/>
    <Player3DComponent v-else-if="type === 'player3d'" :player3d="control as Controls.Player3D.Sender"/>
    <LampComponent v-else-if="type === 'lamp'" :lamp="control as Controls.Lamp.Sender"/>
    <MeterComponent v-else-if="type === 'meter'" :meter="control as Controls.Meter.Sender"/>
    <MenuControlComponent v-else-if="type === 'menu'" :menu="control as Controls.Menu.Sender"/>
    <div v-else>Unknown control type (asd): {{ type }}</div>

    <div v-if="layoutEditMode && !isContainerControl" class="layout-blocker" @pointerdown="onMovePointerDown"></div>

    <template v-if="layoutEditMode">
      <div class="resize-handle corner top-left" @pointerdown="onResizeTopLeftPointerDown"></div>
      <div class="resize-handle corner top-right" @pointerdown="onResizeTopRightPointerDown"></div>
      <div class="resize-handle corner bottom-left" @pointerdown="onResizeBottomLeftPointerDown"></div>
      <div class="resize-handle corner bottom-right" @pointerdown="onResizeXYPointerDown"></div>

      <div class="resize-handle side top" @pointerdown="onResizeTopPointerDown"></div>
      <div class="resize-handle side bottom" @pointerdown="onResizeYPointerDown"></div>
      <div class="resize-handle side left" @pointerdown="onResizeLeftPointerDown"></div>
      <div class="resize-handle side right" @pointerdown="onResizeXPointerDown"></div>
    </template>
  </div>
</template>

<style scoped>
.control {
  position: absolute;
  user-select: none;
}

.layout-edit-mode {
  outline: 1px dashed #6df;
  outline-offset: -1px;
}

.layout-edit-mode {
  cursor: move;
}

.layout-blocker {
  position: absolute;
  inset: 0;
  background: transparent;
  cursor: move;
}

.resize-handle {
  position: absolute;
  background: #4af;
  border: 1px solid #fff;
  box-sizing: border-box;
}

.corner {
  width: 1rem;
  height: 1rem;
}

.top-left {
  left: -1px;
  top: -1px;
  cursor: nwse-resize;
}

.top-right {
  right: -1px;
  top: -1px;
  cursor: nesw-resize;
}

.bottom-left {
  left: -1px;
  bottom: -1px;
  cursor: nesw-resize;
}

.bottom-right {
  right: -1px;
  bottom: -1px;
  cursor: nwse-resize;
}

.side.right {
  right: -1px;
  top: 50%;
  transform: translateY(-50%);
  width: 1rem;
  height: 2rem;
  cursor: ew-resize;
}

.side.left {
  left: -1px;
  top: 50%;
  transform: translateY(-50%);
  width: 1rem;
  height: 2rem;
  cursor: ew-resize;
}

.side.bottom {
  bottom: -1px;
  left: 50%;
  transform: translateX(-50%);
  width: 2rem;
  height: 1rem;
  cursor: ns-resize;
}

.side.top {
  top: -1px;
  left: 50%;
  transform: translateX(-50%);
  width: 2rem;
  height: 1rem;
  cursor: ns-resize;
}

.typelabel {
  position: absolute;
  left: 1rem;
  top: 1rem;
  z-index: 100;
  background-color: #0008;
  color: #f88;
}

.mapping-indicator {
  position: absolute;
  top: 0;
  border: 0.2rem solid #fff8;
  background-color: #3bf;
  border-radius: 0.5rem;
  width: 1rem;
  height: 1rem;
}
</style>
