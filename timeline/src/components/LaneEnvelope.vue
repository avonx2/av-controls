<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted } from 'vue'
import * as Timeline from '../engine'
import { snapTimeToMarkers } from '../snap'

const SVG_HIT_PADDING = 12

const props = defineProps<{
  lane: Timeline.TimelineCurveLane
  laneKey: string
  collapsed?: boolean
  manualOverride?: boolean
  height: number
  width: number
  secondsPerWidth: number
  timeOffset: number
  range: { min: number; max: number; mapping?: 'linear' | 'square' | 'log'; wrap?: boolean }
  snapEnabled?: boolean
  snapMarkers?: number[]
}>()

const emit = defineEmits<{
  'update:points': [points: Timeline.TimelinePoint[]]
}>()

const surfaceRef = ref<HTMLElement | null>(null)
const isViewportVisible = ref(true)
let intersectionObserver: IntersectionObserver | null = null
const accentColor = computed(() => props.manualOverride ? 'rgba(182, 182, 182, 1)' : 'rgba(235, 130, 52, 1)')
const controlColor = computed(() => props.manualOverride ? 'rgba(208, 208, 208, 1)' : 'rgba(150, 220, 255, 1)')
const controlLineColor = computed(() => props.manualOverride ? 'rgba(190, 190, 190, 0.7)' : 'rgba(150, 220, 255, 0.7)')
const controlLineActiveColor = computed(() => props.manualOverride ? 'rgba(224, 224, 224, 1)' : 'rgba(150, 220, 255, 1)')
const controlLineHitColor = computed(() => props.manualOverride ? 'rgba(224, 224, 224, 0.3)' : 'rgba(150, 220, 255, 0.3)')

function clonePointList(points: Timeline.TimelinePoint[]) {
  return points.map(point => ({ ...point }))
}

function pointsEqual(a: Timeline.TimelinePoint[], b: Timeline.TimelinePoint[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!
    const pb = b[i]!
    if (Math.abs(pa.t - pb.t) > 1e-6) return false
    if (Math.abs(pa.v - pb.v) > 1e-6) return false
    if ((pa.kind ?? 'pos') !== (pb.kind ?? 'pos')) return false
  }
  return true
}

const workingPoints = ref<Timeline.TimelinePoint[] | null>(null)
const lastEmittedPoints = ref<Timeline.TimelinePoint[] | null>(null)

function currentPoints() {
  return workingPoints.value ?? props.lane.points
}

function cloneCurrentPoints() {
  return clonePointList(currentPoints())
}

function ensureWorkingPoints() {
  if (!workingPoints.value) {
    workingPoints.value = cloneCurrentPoints()
  }
  return workingPoints.value
}

function scheduleEmit() {
  const points = cloneCurrentPoints()
  lastEmittedPoints.value = points
  emit('update:points', points)
}

function flushEmit() {
  const points = cloneCurrentPoints()
  lastEmittedPoints.value = points
  emit('update:points', points)
}

// ============ Coordinate System ============

const animatedMin = ref(0)
const animatedMax = ref(1)
let animationRafId: number | null = null

const targetRange = computed(() => {
  const visibleTimeMin = props.timeOffset
  const visibleTimeMax = props.timeOffset + props.secondsPerWidth

  const visiblePoints = currentPoints().filter(p => {
    return p.t >= visibleTimeMin && p.t <= visibleTimeMax
  })
  if (visiblePoints.length < 2) {
    return { min: props.range.min, max: props.range.max }
  }

  let minVal = Infinity
  let maxVal = -Infinity
  for (const p of visiblePoints) {
    if (p.v < minVal) minVal = p.v
    if (p.v > maxVal) maxVal = p.v
  }

  if (Math.abs(maxVal - minVal) < 1e-6) {
    return { min: props.range.min, max: props.range.max }
  }

  return { min: minVal, max: maxVal }
})

function initAnimatedValues() {
  animatedMin.value = targetRange.value.min
  animatedMax.value = targetRange.value.max
}

function runAnimation() {
  const deltaMin = targetRange.value.min - animatedMin.value
  const deltaMax = targetRange.value.max - animatedMax.value

  animatedMin.value += deltaMin * 0.1
  animatedMax.value += deltaMax * 0.1

  const span = Math.max(0.001, Math.abs(animatedMax.value - animatedMin.value))
  const threshold = 0.001 * span
  if (Math.abs(deltaMin) < threshold && Math.abs(deltaMax) < threshold) {
    animatedMin.value = targetRange.value.min
    animatedMax.value = targetRange.value.max
    animationRafId = null
    return
  }

  animationRafId = requestAnimationFrame(runAnimation)
}

function startAnimationIfNeeded() {
  if (!isViewportVisible.value) return
  if (animationRafId !== null) return

  const deltaMin = targetRange.value.min - animatedMin.value
  const deltaMax = targetRange.value.max - animatedMax.value
  const span = Math.max(0.001, Math.abs(animatedMax.value - animatedMin.value))
  const threshold = 0.001 * span

  if (Math.abs(deltaMin) > threshold || Math.abs(deltaMax) > threshold) {
    animationRafId = requestAnimationFrame(runAnimation)
  }
}

watch(targetRange, startAnimationIfNeeded, { deep: true })
watch(() => props.lane.key, initAnimatedValues)
watch([animatedMin, animatedMax], () => {
  if (dragState.value) {
    updateDraggedPoint(dragState.value.lastClientX, dragState.value.lastClientY)
  }
})
watch(isViewportVisible, (visible) => {
  if (visible) {
    startAnimationIfNeeded()
    return
  }
  if (animationRafId !== null) {
    cancelAnimationFrame(animationRafId)
    animationRafId = null
  }
})
initAnimatedValues()

onMounted(() => {
  if (!surfaceRef.value) return
  intersectionObserver = new IntersectionObserver((entries) => {
    isViewportVisible.value = entries.some((entry) => entry.isIntersecting)
  }, { threshold: 0 })
  intersectionObserver.observe(surfaceRef.value)
})

onBeforeUnmount(() => {
  if (animationRafId !== null) {
    cancelAnimationFrame(animationRafId)
  }
  intersectionObserver?.disconnect()
})

// ============ Coordinate Transforms ============

function timeToX(time: number, width = props.width) {
  if (!width) return 0
  return ((time - props.timeOffset) / props.secondsPerWidth) * width
}

function xToTime(x: number, width = props.width) {
  if (!width) return 0
  return (x / width) * props.secondsPerWidth + props.timeOffset
}

function applySnap(time: number) {
  if (!props.snapEnabled) return time
  return snapTimeToMarkers(time, props.snapMarkers ?? [], props.width, props.secondsPerWidth)
}

function valueToY(value: number, height = props.height) {
  const min = animatedMin.value
  const max = animatedMax.value
  if (max === min) return height / 2
  const norm = (value - min) / (max - min)
  const topY = maxLineY.value
  const bottomY = minLineY.value
  return bottomY - norm * (bottomY - topY)
}

function yToValue(y: number, clamp: boolean, height = props.height) {
  const min = animatedMin.value
  const max = animatedMax.value
  if (max === min) return min
  const topY = maxLineY.value
  const bottomY = minLineY.value
  const norm = (bottomY - y) / Math.max(1e-6, bottomY - topY)
  const value = min + norm * (max - min)
  return clamp ? clampValue(value) : value
}

function clampValue(value: number) {
  return Math.max(props.range.min, Math.min(props.range.max, value))
}

// ============ Computed Positions ============

const centerLineY = computed(() => props.height * 0.5)
const maxLineY = computed(() => props.height * 0.1)
const minLineY = computed(() => props.height * 0.9)

function formatAxisValue(value: number) {
  if (Math.abs(value) >= 100) return Math.round(value).toString()
  if (Math.abs(value) >= 10) return value.toFixed(1)
  return value.toFixed(3).replace(/\.?0+$/, '')
}

const maxGuideValue = computed(() => animatedMax.value)
const minGuideValue = computed(() => animatedMin.value)

const lanePath = computed(() => {
  if (!currentPoints().length || !props.width) return ''
  const viewStart = props.timeOffset
  const viewEnd = props.timeOffset + props.secondsPerWidth
  const positional = currentPoints().filter(p => (p.kind ?? 'pos') === 'pos')
  const buffer = Timeline.getRenderLaneSampleBuffer(currentPoints(), props.range.min, props.range.max, props.range.wrap ?? false)
  const samples = buffer.getSamplesInRange(viewStart, viewEnd, true, true)
  const holdValues = Timeline.getLaneHoldValues(currentPoints(), props.range.min, props.range.max, props.range.wrap ?? false)
  if (!samples.length && !holdValues) return ''

  const renderSamples: Array<{ t: number; v: number }> = []
  const firstSample = samples[0]
  const lastSample = samples[samples.length - 1]

  if (holdValues && firstSample && viewStart < holdValues.startTime) {
    renderSamples.push({ t: viewStart, v: holdValues.startValue })
    renderSamples.push({ t: Math.min(viewEnd, holdValues.startTime), v: holdValues.startValue })
  }

  renderSamples.push(...samples)

  if (holdValues && lastSample && viewEnd > holdValues.endTime) {
    renderSamples.push({ t: Math.max(viewStart, holdValues.endTime), v: holdValues.endValue })
    renderSamples.push({ t: viewEnd, v: holdValues.endValue })
  }

  if (!renderSamples.length && holdValues) {
    if (viewEnd <= holdValues.startTime) {
      renderSamples.push(
        { t: viewStart, v: holdValues.startValue },
        { t: viewEnd, v: holdValues.startValue },
      )
    } else if (viewStart >= holdValues.endTime) {
      renderSamples.push(
        { t: viewStart, v: holdValues.endValue },
        { t: viewEnd, v: holdValues.endValue },
      )
    } else if (positional.length === 1) {
      renderSamples.push(
        { t: viewStart, v: holdValues.startValue },
        { t: viewEnd, v: holdValues.endValue },
      )
    }
  }

  const dedupedSamples = renderSamples.filter((pt, idx, arr) => {
    if (idx === 0) return true
    const prev = arr[idx - 1]!
    return Math.abs(prev.t - pt.t) > 1e-6 || Math.abs(prev.v - pt.v) > 1e-6
  })

  if (!dedupedSamples.length) return ''

  return dedupedSamples.map((pt, idx) => {
    const x = timeToX(pt.t)
    const y = valueToY(pt.v)
    return `${idx === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
})

const lanePoints = computed(() => {
  return currentPoints().map((point, index) => ({
    ...point,
    index,
    x: timeToX(point.t),
    y: valueToY(point.v),
  }))
})

// Check if a point is within or near the visible viewport
function isPointVisible(x: number, margin = 20) {
  return x >= -margin && x <= props.width + margin
}

// Check if a segment crosses or is within the viewport
function isSegmentVisible(x1: number, x2: number, margin = 20) {
  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  return maxX >= -margin && minX <= props.width + margin
}

const positionalPoints = computed(() => lanePoints.value.filter(p => (p.kind ?? 'pos') === 'pos'))
const controlPoints = computed(() => lanePoints.value.filter(p => (p.kind ?? 'pos') === 'ctrl'))

// Filtered points for rendering (only visible ones)
const visiblePositionalPoints = computed(() => positionalPoints.value.filter(p => isPointVisible(p.x)))
const visibleControlPoints = computed(() => controlPoints.value.filter(p => isPointVisible(p.x)))

type ControlLineSegment = {
  ctrlIndex: number
  posIndex: number
  ctrlX: number
  ctrlY: number
  posX: number
  posY: number
  oppositeCtrlIndex: number | null
}

const controlLineSegments = computed<ControlLineSegment[]>(() => {
  const allPoints = lanePoints.value
  if (!allPoints.length) return []

  const sorted = allPoints.map(p => ({ ...p })).sort((a, b) => a.t - b.t)
  const segments: ControlLineSegment[] = []

  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i]!
    if ((point.kind ?? 'pos') !== 'ctrl') continue

    if (i > 0) {
      const prev = sorted[i - 1]!
      if ((prev.kind ?? 'pos') === 'pos') {
        let oppositeCtrlIndex: number | null = null
        if (i > 1 && (sorted[i - 2]!.kind ?? 'pos') === 'ctrl') {
          oppositeCtrlIndex = sorted[i - 2]!.index
        }
        segments.push({
          ctrlIndex: point.index,
          posIndex: prev.index,
          ctrlX: point.x, ctrlY: point.y,
          posX: prev.x, posY: prev.y,
          oppositeCtrlIndex,
        })
      }
    }

    if (i < sorted.length - 1) {
      const next = sorted[i + 1]!
      if ((next.kind ?? 'pos') === 'pos') {
        let oppositeCtrlIndex: number | null = null
        if (i < sorted.length - 2 && (sorted[i + 2]!.kind ?? 'pos') === 'ctrl') {
          oppositeCtrlIndex = sorted[i + 2]!.index
        }
        segments.push({
          ctrlIndex: point.index,
          posIndex: next.index,
          ctrlX: point.x, ctrlY: point.y,
          posX: next.x, posY: next.y,
          oppositeCtrlIndex,
        })
      }
    }
  }

  return segments
})

// Filter segments to only visible ones
const visibleControlLineSegments = computed(() => {
  return controlLineSegments.value.filter(seg => isSegmentVisible(seg.ctrlX, seg.posX))
})

// ============ Interaction State ============

type SegmentDragInfo = {
  fixedPos: Timeline.TimelinePoint           // The other positional point (A - fixed)
  origMovingPos: { t: number; v: number }    // Original position of B (moving)
  ctrlPoints: Array<{
    point: Timeline.TimelinePoint
    origT: number
    origV: number
  }>
}

const dragState = ref<{
  pointIndex: number
  point: Timeline.TimelinePoint
  startX: number
  startY: number
  pointStartX: number
  pointStartY: number
  moved: boolean
  createdOnPointerDown: boolean
  lastClientX: number
  lastClientY: number
  // For positional points: segment info for affine/direction-preserving transforms
  leftSegment?: SegmentDragInfo   // Segment where dragged point is B (right end)
  rightSegment?: SegmentDragInfo  // Segment where dragged point is A (left end)
  prevBound: Timeline.TimelinePoint | null  // Enclosing pos to the left (for clamping)
  nextBound: Timeline.TimelinePoint | null  // Enclosing pos to the right (for clamping)
  clamped: boolean
} | null>(null)

const lineDragState = ref<{
  pos: Timeline.TimelinePoint
  ctrl: Timeline.TimelinePoint
  oppositeCtrl: Timeline.TimelinePoint | null
  prevBound: Timeline.TimelinePoint | null
  nextBound: Timeline.TimelinePoint | null
  startX: number
  startY: number
  ctrlStartX: number
  ctrlStartY: number
  origCtrlDist: number
  origOppDist: number
} | null>(null)

const hoveredLine = ref<{ ctrlIndex: number; posIndex: number } | null>(null)
const dragIndicator = ref<{ y: number; value: number } | null>(null)
// Smooth points: local UI state tracking which pos points have smooth tangents
// Set when: dragging lines, or on load if nearly perfectly collinear
const smoothPoints = new Set<Timeline.TimelinePoint>()

// Initialize smooth points on load - detect near-perfect collinearity (float precision)
function initializeSmoothPoints() {
  smoothPoints.clear()
  const points = currentPoints()
  const sorted = points.slice().sort((a, b) => a.t - b.t)

  for (let i = 0; i < sorted.length; i++) {
    const pos = sorted[i]!
    if ((pos.kind ?? 'pos') !== 'pos') continue

    const before = sorted[i - 1]
    const after = sorted[i + 1]
    if (!before || !after) continue
    if ((before.kind ?? 'pos') !== 'ctrl' || (after.kind ?? 'pos') !== 'ctrl') continue

    // Very tight tolerance for floating point precision only
    const cross = (after.t - before.t) * (pos.v - before.v) - (after.v - before.v) * (pos.t - before.t)
    const len1 = Math.hypot(pos.t - before.t, pos.v - before.v)
    const len2 = Math.hypot(after.t - before.t, after.v - before.v)
    if (len1 < 1e-9 || len2 < 1e-9) continue

    // Tolerance ~1e-6 for floating point errors only
    if (Math.abs(cross) / (len1 * len2) < 1e-6) {
      smoothPoints.add(pos)
    }
  }
}

watch(() => props.lane.points, (points) => {
  if (dragState.value || lineDragState.value) return
  const next = clonePointList(points)
  if (lastEmittedPoints.value && pointsEqual(next, lastEmittedPoints.value)) {
    lastEmittedPoints.value = null
    workingPoints.value = null
    return
  }
  workingPoints.value = null
}, { deep: true })

watch([workingPoints, () => props.lane.points], initializeSmoothPoints, { deep: true, immediate: true })

// Smooth: check local UI state
function isPointSmooth(posIndex: number) {
  const point = currentPoints()[posIndex]
  return point ? smoothPoints.has(point) : false
}

// Remove smooth state from positional points that are IMMEDIATELY adjacent to a control point
// (only if no other control point is between them)
function clearSmoothForAdjacentPositional(ctrlPoint: Timeline.TimelinePoint) {
  const sorted = currentPoints().slice().sort((a, b) => a.t - b.t)
  const ctrlIdx = sorted.indexOf(ctrlPoint)
  if (ctrlIdx < 0) return

  // Check immediate neighbor before - if it's a positional point, clear its smooth
  const before = sorted[ctrlIdx - 1]
  if (before && (before.kind ?? 'pos') === 'pos') {
    smoothPoints.delete(before)
  }

  // Check immediate neighbor after - if it's a positional point, clear its smooth
  const after = sorted[ctrlIdx + 1]
  if (after && (after.kind ?? 'pos') === 'pos') {
    smoothPoints.delete(after)
  }
}

function isPointDragging(index: number) {
  return dragState.value?.point === currentPoints()[index]
}

function isLineDragging(segment: ControlLineSegment) {
  if (!lineDragState.value) return false
  const { pos, ctrl, oppositeCtrl } = lineDragState.value
  const segPos = currentPoints()[segment.posIndex]
  const segCtrl = currentPoints()[segment.ctrlIndex]
  return segPos === pos && (segCtrl === ctrl || segCtrl === oppositeCtrl)
}

function isLineHovered(segment: ControlLineSegment) {
  if (!hoveredLine.value) return false
  return hoveredLine.value.ctrlIndex === segment.ctrlIndex &&
         hoveredLine.value.posIndex === segment.posIndex
}

// ============ Event Handlers ============

function emitPoints() {
  const points = cloneCurrentPoints()
  lastEmittedPoints.value = points
  emit('update:points', points)
}

function beginCreatedPointDrag(event: PointerEvent, newPoint: Timeline.TimelinePoint, value: number) {
  const rect = surfaceRef.value?.getBoundingClientRect()
  if (!rect) return
  dragState.value = {
    pointIndex: ensureWorkingPoints().indexOf(newPoint),
    point: newPoint,
    startX: event.clientX,
    startY: event.clientY,
    pointStartX: timeToX(newPoint.t, props.width),
    pointStartY: valueToY(newPoint.v, rect.height),
    moved: false,
    createdOnPointerDown: true,
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    prevBound: null,
    nextBound: null,
    clamped: false,
  }
  dragIndicator.value = { y: event.clientY - rect.top, value }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function sampleEnvelopeValueAtTime(time: number) {
  const points = currentPoints()
  if (!points.length) return null
  const buffer = Timeline.getRenderLaneSampleBuffer(
    points,
    props.range.min,
    props.range.max,
    props.range.wrap ?? false,
  )
  return buffer.getValue(time)
}

function addPointAtPointer(event: PointerEvent, kind: 'pos' | 'ctrl') {
  const rect = surfaceRef.value?.getBoundingClientRect()
  if (!rect) return
  const time = applySnap(xToTime(event.clientX - rect.left, props.width))
  const sampledValue = kind === 'pos' ? sampleEnvelopeValueAtTime(time) : null
  const value = sampledValue ?? yToValue(event.clientY - rect.top, kind === 'pos', rect.height)
  const newPoint: Timeline.TimelinePoint = { t: time, v: value, kind }
  ensureWorkingPoints().push(newPoint)

  if (kind === 'ctrl') {
    clearSmoothForAdjacentPositional(newPoint)
  }

  emitPoints()
  beginCreatedPointDrag(event, newPoint, value)
}

function onSurfacePointerDown(event: PointerEvent) {
  // Skip if ctrl/cmd held (pan mode)
  if (props.collapsed || event.ctrlKey || event.metaKey) return

  const wantsCtrl = event.shiftKey
  const hasPositional = currentPoints().some(pt => (pt.kind ?? 'pos') === 'pos')
  const kind: 'pos' | 'ctrl' = wantsCtrl && hasPositional ? 'ctrl' : 'pos'
  addPointAtPointer(event, kind)
}

function onPointPointerDown(event: PointerEvent, index: number) {
  // Skip if ctrl/cmd held (pan mode)
  if (event.ctrlKey || event.metaKey) return

  event.stopPropagation()
  event.preventDefault()

  const points = ensureWorkingPoints()
  const point = points[index]
  if (!point) return

  let leftSegment: SegmentDragInfo | undefined
  let rightSegment: SegmentDragInfo | undefined
  let prevBound: Timeline.TimelinePoint | null = null
  let nextBound: Timeline.TimelinePoint | null = null

  if ((point.kind ?? 'pos') === 'pos') {
    const points = currentPoints()
    // Sort all points by time
    const sorted = points.slice().sort((a, b) => a.t - b.t)
    const sortedIdx = sorted.indexOf(point)

    // Find all positional points sorted by time
    const allPos = sorted.filter(p => (p.kind ?? 'pos') === 'pos')
    const posIdx = allPos.indexOf(point)

    // Enclosing positional points for clamping
    prevBound = posIdx > 0 ? allPos[posIdx - 1]! : null
    nextBound = posIdx < allPos.length - 1 ? allPos[posIdx + 1]! : null

    // Left segment: from prevBound to this point (this point is B/moving)
    if (prevBound) {
      const ctrlPoints: SegmentDragInfo['ctrlPoints'] = []
      // Collect control points between prevBound and this point
      for (const p of sorted) {
        if ((p.kind ?? 'pos') === 'ctrl' && p.t > prevBound.t && p.t < point.t) {
          ctrlPoints.push({ point: p, origT: p.t, origV: p.v })
        }
      }
      if (ctrlPoints.length > 0) {
        leftSegment = {
          fixedPos: prevBound,
          origMovingPos: { t: point.t, v: point.v },
          ctrlPoints,
        }
      }
    }

    // Right segment: from this point to nextBound (this point is A/moving)
    if (nextBound) {
      const ctrlPoints: SegmentDragInfo['ctrlPoints'] = []
      // Collect control points between this point and nextBound
      for (const p of sorted) {
        if ((p.kind ?? 'pos') === 'ctrl' && p.t > point.t && p.t < nextBound.t) {
          ctrlPoints.push({ point: p, origT: p.t, origV: p.v })
        }
      }
      if (ctrlPoints.length > 0) {
        rightSegment = {
          fixedPos: nextBound,
          origMovingPos: { t: point.t, v: point.v },
          ctrlPoints,
        }
      }
    }
  }

  dragState.value = {
    pointIndex: index,
    point,
    startX: event.clientX,
    startY: event.clientY,
    pointStartX: timeToX(point.t, props.width),
    pointStartY: valueToY(point.v),
    moved: false,
    createdOnPointerDown: false,
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    leftSegment,
    rightSegment,
    prevBound,
    nextBound,
    clamped: false,
  }
  dragIndicator.value = { y: valueToY(point.v), value: point.v }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function updateDraggedPoint(clientX: number, clientY: number) {
  if (!dragState.value || !surfaceRef.value) return

  const { point, leftSegment, rightSegment, prevBound, nextBound, startX, startY, pointStartX, pointStartY } = dragState.value
  const isPositional = (point.kind ?? 'pos') === 'pos'
  const rect = surfaceRef.value.getBoundingClientRect()
  const relativeDragX = clientX - startX
  const relativeDragY = clientY - startY
  const handleX = pointStartX + relativeDragX
  const handleY = pointStartY + relativeDragY

  let newT = applySnap(xToTime(handleX, props.width))
  const rawValue = yToValue(handleY, isPositional, rect.height)
  let newV = rawValue

  // Clamp positional points to not go past enclosing positional points
  if (isPositional) {
    const minT = prevBound ? prevBound.t : -Infinity
    const maxT = nextBound ? nextBound.t : Infinity
    if (newT <= minT || newT >= maxT) {
      dragState.value.clamped = true
      newT = Math.max(minT + 0.001, Math.min(maxT - 0.001, newT))
    }
  }

  point.t = newT
  point.v = newV

  // Clear smooth state when moving a control point individually
  if (!isPositional) {
    clearSmoothForAdjacentPositional(point)
  }

  // Apply affine X and direction-preserving Y to control points in adjacent segments
  if (isPositional) {
    // Left segment: this point is B (moving), fixedPos is A
    if (leftSegment) {
      updateSegmentControlPoints(leftSegment, leftSegment.fixedPos, point, true)
      // If only 1 control point in segment, the fixed endpoint loses smooth
      // (because control points are now asymmetric around it)
      if (leftSegment.ctrlPoints.length === 1) {
        smoothPoints.delete(leftSegment.fixedPos)
      }
    }

    // Right segment: this point is A (moving), fixedPos is B
    if (rightSegment) {
      updateSegmentControlPoints(rightSegment, point, rightSegment.fixedPos, false)
      // If only 1 control point in segment, the fixed endpoint loses smooth
      if (rightSegment.ctrlPoints.length === 1) {
        smoothPoints.delete(rightSegment.fixedPos)
      }
    }
  }

  dragIndicator.value = { y: valueToY(point.v, rect.height), value: point.v }
  scheduleEmit()
}

/**
 * Update control points in a segment using affine X scaling and direction-preserving Y.
 * @param segment - The segment info with original control point positions
 * @param posA - Current position of left positional point
 * @param posB - Current position of right positional point
 * @param movingIsB - true if B is the moving point, false if A is moving
 */
function updateSegmentControlPoints(
  segment: SegmentDragInfo,
  posA: Timeline.TimelinePoint,
  posB: Timeline.TimelinePoint,
  movingIsB: boolean
) {
  const { fixedPos, origMovingPos, ctrlPoints } = segment
  const n = ctrlPoints.length
  if (n === 0) return

  // Original segment endpoints
  const origA = movingIsB ? { t: fixedPos.t, v: fixedPos.v } : origMovingPos
  const origB = movingIsB ? origMovingPos : { t: fixedPos.t, v: fixedPos.v }
  const origSegmentLen = origB.t - origA.t
  if (Math.abs(origSegmentLen) < 0.0001) return

  // New segment endpoints
  const newA = { t: posA.t, v: posA.v }
  const newB = { t: posB.t, v: posB.v }
  const newSegmentLen = newB.t - newA.t
  if (Math.abs(newSegmentLen) < 0.0001) return

  // Scale factor
  const s = newSegmentLen / origSegmentLen

  // Sort control points by original t to find leftmost/rightmost
  const sortedCtrls = ctrlPoints.slice().sort((a, b) => a.origT - b.origT)
  const t1 = sortedCtrls[0]!.origT  // leftmost original t
  const tn = sortedCtrls[n - 1]!.origT  // rightmost original t
  const ctrlSpan = tn - t1

  for (const ctrl of ctrlPoints) {
    const { point, origT, origV } = ctrl

    // Step 1: Affine X scaling from A
    const newCtrlT = newA.t + s * (origT - origA.t)

    // Step 2: Calculate target Y for direction from A
    const targetY_A = newA.v + s * (origV - origA.v)

    // Step 3: Calculate target Y for direction from B
    const targetY_B = newB.v + s * (origV - origB.v)

    // Step 4: Blend weight
    let weight: number
    if (n === 1 || ctrlSpan < 0.0001) {
      // Special case: single control point or all at same x
      // Preserve direction toward the moving positional point
      weight = movingIsB ? 1 : 0
    } else {
      // Weight based on position within control point span
      weight = (origT - t1) / ctrlSpan
    }

    // Step 5: Final Y
    const newCtrlV = (1 - weight) * targetY_A + weight * targetY_B

    point.t = newCtrlT
    point.v = newCtrlV
  }
}

function onPointerMove(event: PointerEvent) {
  if (!dragState.value) return

  const { startX, startY } = dragState.value
  if (!dragState.value.moved && Math.hypot(event.clientX - startX, event.clientY - startY) > 3) {
    dragState.value.moved = true
  }

  dragState.value.lastClientX = event.clientX
  dragState.value.lastClientY = event.clientY

  updateDraggedPoint(event.clientX, event.clientY)
}

function onPointerUp() {
  if (dragState.value && !dragState.value.moved && !dragState.value.createdOnPointerDown) {
    // Click without drag - remove the point
    const point = dragState.value.point
    const isCtrl = (point.kind ?? 'pos') === 'ctrl'

    // Clear smooth state for adjacent positionals before removing a control point
    if (isCtrl) {
      clearSmoothForAdjacentPositional(point)
    }

    const points = ensureWorkingPoints()
    const idx = dragState.value.pointIndex
    if (idx >= 0) {
      points.splice(idx, 1)
      emitPoints()
    }
  } else if (dragState.value) {
    // Check if we're clamped - if so, remove control points in collapsed segment
    if (dragState.value.clamped) {
      const { point, prevBound, nextBound, leftSegment, rightSegment } = dragState.value

      // Check if clamped to left (same x as prevBound)
      if (prevBound && Math.abs(point.t - prevBound.t) < 0.01) {
        // Remove control points from left segment - clear smooth for the fixed endpoint
        if (leftSegment) {
          smoothPoints.delete(prevBound)
          const points = ensureWorkingPoints()
          for (const ctrl of leftSegment.ctrlPoints) {
            const idx = points.indexOf(ctrl.point)
            if (idx >= 0) points.splice(idx, 1)
          }
        }
      }

      // Check if clamped to right (same x as nextBound)
      if (nextBound && Math.abs(point.t - nextBound.t) < 0.01) {
        // Remove control points from right segment - clear smooth for the fixed endpoint
        if (rightSegment) {
          smoothPoints.delete(nextBound)
          const points = ensureWorkingPoints()
          for (const ctrl of rightSegment.ctrlPoints) {
            const idx = points.indexOf(ctrl.point)
            if (idx >= 0) points.splice(idx, 1)
          }
        }
      }
    }

    // Drag ended - flush any pending emit
    flushEmit()
  }

  dragState.value = null
  dragIndicator.value = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
}

function onLinePointerDown(event: PointerEvent, segment: ControlLineSegment) {
  // Skip if ctrl/cmd held (pan mode)
  if (event.ctrlKey || event.metaKey) return

  event.stopPropagation()
  event.preventDefault()

  if (event.shiftKey) {
    addPointAtPointer(event, 'ctrl')
    return
  }

  const points = ensureWorkingPoints()
  const pos = points[segment.posIndex]
  const ctrl = points[segment.ctrlIndex]
  if (!pos || !ctrl) return

  const oppositeCtrl = segment.oppositeCtrlIndex !== null
    ? points[segment.oppositeCtrlIndex] ?? null
    : null

  // Find enclosing positional points
  const sorted = points
    .filter(p => (p.kind ?? 'pos') === 'pos')
    .sort((a, b) => a.t - b.t)
  const posIdx = sorted.indexOf(pos)
  const prevBound = posIdx > 0 ? sorted[posIdx - 1]! : null
  const nextBound = posIdx < sorted.length - 1 ? sorted[posIdx + 1]! : null

  lineDragState.value = {
    pos,
    ctrl,
    oppositeCtrl,
    prevBound,
    nextBound,
    startX: event.clientX,
    startY: event.clientY,
    ctrlStartX: timeToX(ctrl.t, props.width),
    ctrlStartY: valueToY(ctrl.v),
    origCtrlDist: Math.hypot(ctrl.t - pos.t, ctrl.v - pos.v),
    origOppDist: oppositeCtrl ? Math.hypot(oppositeCtrl.t - pos.t, oppositeCtrl.v - pos.v) : 0,
  }

  // Mark as smooth when dragging a line with control points on both sides
  if (oppositeCtrl) {
    smoothPoints.add(pos)
  }

  window.addEventListener('pointermove', onLineDragMove)
  window.addEventListener('pointerup', onLineDragUp)
}

function onLineDragMove(event: PointerEvent) {
  if (!lineDragState.value || !surfaceRef.value) return

  const { pos, ctrl, oppositeCtrl, prevBound, nextBound, startX, startY, ctrlStartX, ctrlStartY, origCtrlDist, origOppDist } = lineDragState.value
  const rect = surfaceRef.value.getBoundingClientRect()
  const relativeDragX = event.clientX - startX
  const relativeDragY = event.clientY - startY
  const handleX = ctrlStartX + relativeDragX
  const handleY = ctrlStartY + relativeDragY
  const time = xToTime(handleX, props.width)
  const value = yToValue(handleY, false, rect.height)

  const dt = time - pos.t
  const dv = value - pos.v
  const dist = Math.hypot(dt, dv)
  if (dist < 0.0001) return

  // Calculate new ctrl position, clamped to bounds
  let ctrlScale = origCtrlDist / dist
  let newCtrlT = pos.t + dt * ctrlScale
  let newCtrlV = pos.v + dv * ctrlScale

  const ctrlBound = dt > 0 ? nextBound?.t ?? Infinity : prevBound?.t ?? -Infinity
  if ((dt > 0 && newCtrlT >= ctrlBound) || (dt < 0 && newCtrlT <= ctrlBound)) {
    const maxDist = Math.abs(ctrlBound - pos.t) * 0.99
    const ratio = maxDist / Math.abs(newCtrlT - pos.t)
    newCtrlT = pos.t + (newCtrlT - pos.t) * ratio
    newCtrlV = pos.v + (newCtrlV - pos.v) * ratio
  }

  ctrl.t = newCtrlT
  ctrl.v = newCtrlV

  // Calculate opposite ctrl if exists
  if (oppositeCtrl && origOppDist > 0) {
    let oppScale = origOppDist / dist
    let newOppT = pos.t - dt * oppScale
    let newOppV = pos.v - dv * oppScale

    const oppBound = dt > 0 ? prevBound?.t ?? -Infinity : nextBound?.t ?? Infinity
    if ((dt > 0 && newOppT <= oppBound) || (dt < 0 && newOppT >= oppBound)) {
      const maxDist = Math.abs(oppBound - pos.t) * 0.99
      const ratio = maxDist / Math.abs(newOppT - pos.t)
      newOppT = pos.t + (newOppT - pos.t) * ratio
      newOppV = pos.v + (newOppV - pos.v) * ratio
    }

    oppositeCtrl.t = newOppT
    oppositeCtrl.v = newOppV
  }

  scheduleEmit()
}

function onLineDragUp() {
  flushEmit()
  lineDragState.value = null
  window.removeEventListener('pointermove', onLineDragMove)
  window.removeEventListener('pointerup', onLineDragUp)
}
</script>

<template>
  <div
    ref="surfaceRef"
    class="lane-surface"
    :class="{ collapsed }"
    @pointerdown.prevent="onSurfacePointerDown"
  >
    <div v-if="!collapsed" class="lane-center-line" :style="{ top: `${centerLineY}px` }" />
    <div v-if="!collapsed" class="lane-range-line" :style="{ top: `${maxLineY}px` }" />
    <div v-if="!collapsed" class="lane-range-line" :style="{ top: `${minLineY}px` }" />

    <div v-if="!collapsed" class="lane-range-label lane-max-label" :style="{ top: `${maxLineY}px` }">
      {{ formatAxisValue(maxGuideValue) }}
    </div>
    <div v-if="!collapsed" class="lane-range-label lane-min-label" :style="{ top: `${minLineY}px` }">
      {{ formatAxisValue(minGuideValue) }}
    </div>
      <div v-if="!collapsed && laneKey !== 'value'" class="lane-key-label" :style="{ top: `${centerLineY}px` }">
        {{ laneKey }}
      </div>

    <template v-if="!collapsed && dragIndicator">
      <div class="lane-drag-line" :style="{ top: `${dragIndicator.y}px` }" />
      <div class="lane-drag-value" :style="{ top: `${dragIndicator.y}px` }">
        {{ dragIndicator.value.toFixed(3) }}
      </div>
    </template>

    <svg
      class="lane-envelope"
      :viewBox="`0 ${-SVG_HIT_PADDING} ${Math.max(1, width)} ${Math.max(1, height + SVG_HIT_PADDING * 2)}`"
      preserveAspectRatio="none"
      :style="{ top: `${-SVG_HIT_PADDING}px`, height: `calc(100% + ${SVG_HIT_PADDING * 2}px)` }"
    >
      <path v-if="lanePath" class="lane-path" :d="lanePath" />

      <!-- Control lines -->
      <g
        v-if="!collapsed"
        v-for="segment in visibleControlLineSegments"
        :key="`line-${segment.ctrlIndex}-${segment.posIndex}`"
        class="lane-line-group"
        :class="{ hovered: isLineHovered(segment), dragging: isLineDragging(segment) }"
        @pointerenter="hoveredLine = { ctrlIndex: segment.ctrlIndex, posIndex: segment.posIndex }"
        @pointerleave="hoveredLine = null"
        @pointerdown.stop.prevent="onLinePointerDown($event, segment)"
      >
        <line class="lane-line-hit" :x1="segment.ctrlX" :y1="segment.ctrlY" :x2="segment.posX" :y2="segment.posY" />
        <line class="lane-line" :x1="segment.ctrlX" :y1="segment.ctrlY" :x2="segment.posX" :y2="segment.posY" />
      </g>

      <!-- Positional points -->
      <g
        v-if="!collapsed"
        v-for="point in visiblePositionalPoints"
        :key="`pos-${point.index}`"
        class="lane-point-group"
        :class="{ dragging: isPointDragging(point.index) }"
        @pointerdown="onPointPointerDown($event, point.index)"
      >
        <circle
          class="lane-point lane-point-pos"
          :class="{ smooth: isPointSmooth(point.index) }"
          :cx="point.x" :cy="point.y" r="6"
        />
        <circle class="lane-point-hit lane-point-pos" :cx="point.x" :cy="point.y" r="12" />
      </g>

      <!-- Control points -->
      <g
        v-if="!collapsed"
        v-for="point in visibleControlPoints"
        :key="`ctrl-${point.index}`"
        class="lane-point-group"
        :class="{ dragging: isPointDragging(point.index) }"
        @pointerdown="onPointPointerDown($event, point.index)"
      >
        <circle class="lane-point lane-point-ctrl" :cx="point.x" :cy="point.y" r="5" />
        <circle class="lane-point-hit lane-point-ctrl" :cx="point.x" :cy="point.y" r="10" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.lane-surface {
  position: absolute;
  inset: 0;
  cursor: crosshair;
  background: rgba(255,255,255,0.012);
}

.lane-center-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px dotted rgba(255, 255, 255, 0.2);
  pointer-events: none;
  z-index: 1;
}

.lane-range-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px dotted rgba(255, 255, 255, 0.25);
  pointer-events: none;
  z-index: 1;
}

.lane-range-label {
  position: absolute;
  left: 0.3rem;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.87);
  pointer-events: none;
  z-index: 2;
}

.lane-max-label,
.lane-min-label {
  transform: translateY(-50%);
}

.lane-key-label {
  position: absolute;
  left: 0.3rem;
  transform: translateY(-50%);
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.5);
  pointer-events: none;
  white-space: nowrap;
  z-index: 2;
}

.lane-drag-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px dotted rgba(255, 255, 255, 0.45);
  pointer-events: none;
  z-index: 2;
}

.lane-drag-value {
  position: absolute;
  right: 0.35rem;
  transform: translateY(-50%);
  padding: 0 0.35rem;
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(15, 17, 21, 0.6);
  border-radius: 0.25rem;
  pointer-events: none;
  z-index: 3;
}

.lane-envelope {
  position: absolute;
  left: 0;
  right: 0;
  width: 100%;
  pointer-events: none;
}

.lane-envelope > * {
  pointer-events: auto;
}

.lane-path {
  fill: none;
  stroke: v-bind(accentColor);
  stroke-width: 1.5;
  pointer-events: none;
}

.lane-point {
  fill: v-bind(accentColor);
  stroke: rgba(15, 17, 21, 0.8);
  stroke-width: 1;
}

.lane-point.smooth {
  fill: rgba(15, 17, 21, 0.8);
  stroke: v-bind(accentColor);
  stroke-width: 2;
}

.lane-point-ctrl {
  fill: v-bind(controlColor);
}

.lane-point-group {
  cursor: pointer;
}

.lane-point-hit {
  opacity: 0;
  transition: opacity 0.12s ease;
}

.lane-point-group:hover .lane-point-hit,
.lane-point-group.dragging .lane-point-hit {
  opacity: 0.45;
}

.lane-point-hit.lane-point-pos {
  fill: v-bind(accentColor);
}

.lane-point-hit.lane-point-ctrl {
  fill: v-bind(controlColor);
}

.lane-line-group {
  cursor: pointer;
}

.lane-line {
  stroke: v-bind(controlLineColor);
  stroke-width: 1;
}

.lane-line-hit {
  stroke: transparent;
  stroke-width: 12;
  stroke-linecap: round;
}

.lane-line-group:hover .lane-line,
.lane-line-group.hovered .lane-line,
.lane-line-group.dragging .lane-line {
  stroke: v-bind(controlLineActiveColor);
  stroke-width: 2;
}

.lane-line-group:hover .lane-line-hit,
.lane-line-group.hovered .lane-line-hit,
.lane-line-group.dragging .lane-line-hit {
  stroke: v-bind(controlLineHitColor);
}

</style>
