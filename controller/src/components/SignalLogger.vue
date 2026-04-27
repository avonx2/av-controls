<script setup lang=ts>
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import {
  InputMappings,
  type InputSignal,
  NoteOn, NoteOff,
  ControlChange,
  KeyboardSignal,
  type KeyMidiSignal
} from '../input-mappings'

import type { InputSource } from '../input-mappings'
import { KeyboardSource, MidiSource as ProtocolMidiSource } from 'av-controls'

const windowSize = 10000
let lastCleanup = 0

const startTime = ref(Date.now())
const endTime = ref(Date.now() + windowSize)
const width = ref(1)

const canvas = ref(null as HTMLCanvasElement | null)

const props = defineProps<{
  inputMappings: InputMappings
}>()

function tryResize() {
  if(canvas.value) {
    width.value = canvas.value.clientWidth
  }
}

function onWindowResize() {
  tryResize()
}

const normalizeFactor = computed(() => 1 / (endTime.value - startTime.value) * width.value)

interface Activity {
  on: number
  off: number
}

abstract class SignalRecord {
  public activities: Activity[] = []

  public abstract name: string
  public abstract signalType: 'midi' | 'keyboard'

  updateEndTime(time: number) {
    if(time > endTime.value) {
      endTime.value = time
    }
    if(startTime.value < time - windowSize) {
      startTime.value = time - windowSize
    }
    if(startTime.value > lastCleanup + windowSize / 2) {
      lastCleanup = startTime.value
      for(const id in recordsStore.value) {
        const control = recordsStore.value[id]
        if (control) {
          control.activities = control.activities.filter(activity => activity.off > startTime.value)
        }
      }
    }
  }
}

const touchLength = 100
class ControllerSignalRecord extends SignalRecord {
  public signalType: 'midi' | 'keyboard' = 'midi'

  constructor(
    public name: string,
  ) {
    super()
  }

  touch() {
    const time = Date.now()
    const recentActivity = this.activities[this.activities.length - 1]
    if(recentActivity && time - recentActivity.off < touchLength) {
      recentActivity.off = time
    } else {
      this.activities.push({
        on: time,
        off: time + touchLength
      })
    }
    this.updateEndTime(time + touchLength)
  }
}

class KeySignalRecord extends SignalRecord {
  private pressed: number | undefined

  constructor(
    public name: string,
    public signalType: 'midi' | 'keyboard'
  ) {
    super()
  }

  on() {
    this.pressed = Date.now()
  }

  off() {
    const time = Date.now()
    this.activities.push({
      on: this.pressed ?? startTime.value,
      off: time
    })
    this.pressed = undefined
    this.updateEndTime(time)
  }
}

const recordsStore = ref({} as {[key: string]: SignalRecord})

const MOCK_TEST_SIGNAL = false

onMounted(() => {
  props.inputMappings.addListener(onInputSignal)
  window.addEventListener('resize', onWindowResize)
  startTime.value = Date.now()
  recordsStore.value
  tryResize()
  if(MOCK_TEST_SIGNAL){
    const s = new ControllerSignalRecord('test')
    recordsStore.value['test signal'] = s
    s.touch()
  }
})

onBeforeUnmount(() => {
  props.inputMappings.removeListener(onInputSignal)
  window.removeEventListener('resize', onWindowResize)
})

function getOrCreateMidiKeySignalRecord(s: KeyMidiSignal) {
  let control = recordsStore.value[s.sourceId] as KeySignalRecord | undefined
  if(!control) {
    control = new KeySignalRecord(`MIDI Note ${s.key}, Ch ${s.channel}`, 'midi')
    recordsStore.value[s.sourceId] = control
  }
  return control
}

function getOrCreateKeyboardSignalRecord(s: KeyboardSignal) {
  let control = recordsStore.value[s.sourceId] as KeySignalRecord | undefined
  if(!control) {
    const displayKey = s.key.length === 1 ? s.key.toUpperCase() : s.code
    control = new KeySignalRecord(`Keyboard: ${displayKey}`, 'keyboard')
    recordsStore.value[s.sourceId] = control
  }
  return control
}

function onInputSignal(s: InputSignal) {
  console.log('SignalLogger received signal:', s.type, s.sourceId, s instanceof KeyboardSignal);

  // Handle MIDI signals
  if(s instanceof NoteOn) {
    getOrCreateMidiKeySignalRecord(s).on()
  } else if(s instanceof NoteOff) {
    getOrCreateMidiKeySignalRecord(s).off()
  } else if(s instanceof ControlChange) {
    let control = recordsStore.value[s.sourceId] as ControllerSignalRecord | undefined
    if(!control) {
      control = new ControllerSignalRecord(`MIDI CC ${s.cc}, Ch ${s.channel}`)
      recordsStore.value[s.sourceId] = control
    }
    control.touch()
  }
  // Handle Keyboard signals
  else if(s instanceof KeyboardSignal) {
    console.log('Handling keyboard signal');
    const record = getOrCreateKeyboardSignalRecord(s)
    if(s.pressed) {
      record.on()
    } else {
      record.off()
    }
  } else {
    console.warn('Unknown signal type:', s);
  }
}

const emit = defineEmits(['select'])

const selected = ref(null as number | null)

function tap(record: SignalRecord, sourceId: string, i: number) {
  if(selected.value === i) {
    // Create appropriate InputSource based on signal type
    let inputSource: InputSource | undefined

    if(record instanceof KeySignalRecord) {
      if(record.signalType === 'keyboard') {
        // Extract code from sourceId (format: "keyboard-{code}")
        const code = sourceId.replace('keyboard-', '')
        // We need to reconstruct the key, but we only have code in sourceId
        // For now, use code as key (this is a simplification)
        inputSource = new KeyboardSource(code, code)
      } else {
        // MIDI key signal
        inputSource = new ProtocolMidiSource(sourceId, 'key')
      }
    } else if(record instanceof ControllerSignalRecord) {
      // MIDI CC signal
      inputSource = new ProtocolMidiSource(sourceId, 'cc')
    }

    if(inputSource) {
      emit('select', inputSource)
    }
  } else {
    selected.value = i
  }
}

const lineHeight = 35
const lines = computed(() => Object.keys(recordsStore.value).length)

function laneY(i: number, offset: number) {
  const height = laneHeight(i)
  let shift = 0
  if(selected.value !== null && i > selected.value) {
    shift = 1
  }
  return (i + shift) * lineHeight + laneHeight(i) * offset
}

function laneHeight(i: number) {
  return i === selected.value ? lineHeight * 2 : lineHeight
}

</script>

<template>
  <div class="panel">
    <h3>Supported Mappings</h3>
    <ul>
      <li>MIDI Key/Note → Pad/Switch</li>
      <li>MIDI CC → Fader/Knob</li>
      <li>Keyboard Key → Pad/Switch</li>
      <li>more to come...</li>
    </ul>
  </div>
  <svg class=canvas ref=canvas width="100%" :height="lineHeight * (lines + (selected !== null ? 1 : 0))">
    <rect v-for="record, id, i in recordsStore" :key="id" class='lane-background' :class='{selected: i==selected, keyboard: record.signalType === "keyboard"}' :y="laneY(i, 0)" :width="width" :height="laneHeight(i)" @click="tap(record, String(id), i)" />
    <g v-for="control, id, i in recordsStore" :key="id">
      <rect class='lane-activity' :class='{keyboard: control.signalType === "keyboard"}' v-for="activity, j in control.activities" :key="j" :x="normalizeFactor * (activity.on - startTime)" :y="laneY(i, 0.2)" :width="normalizeFactor * (activity.off - activity.on)" :height="0.6 * laneHeight(i)" />
      <text class='lane-label' :x="10" :y="laneY(i, 0.5)">{{ control.name }}</text>
    </g>
  </svg>
</template>

<style scoped>

.canvas {
  margin: 0.5rem;
}

.lane-background {
  fill: #222;
  rx: 5;
  ry: 5;
  cursor: pointer;
}

.lane-background:nth-child(even) {
  fill: #333;
}

.lane-background.keyboard {
  fill: #332;
}

.lane-background.keyboard:nth-child(even) {
  fill: #443;
}

.lane-background:hover {
  fill: #777;
}

.lane-background.selected {
  fill: #b50;
}

.lane-label {
  fill: #fff;
  text-anchor: left;
  dominant-baseline: middle;
  pointer-events: none;
}

.lane-activity {
  fill: #8cf;
  pointer-events: none;
  rx: 5;
  ry: 5;
}

.lane-activity.keyboard {
  fill: #f8c;
}

.panel .button{
  display: inline-block;
  width: 10rem;
  height: 10rem;
  line-height: 10rem;
  border-radius: 1rem;
  text-align: center;
  background-color: #444;
  font-weight: bold;
  box-shadow: 0 0 2rem #000;
}

.panel {
  position: absolute;
  bottom: 1rem;
  right: 1rem;
  padding: 0.5rem 2rem;
  background-color: #fff2;
  border-radius: 0.5rem;
}

.panel h3 {
  margin-top: 0;
}

.panel ul {
  margin: 0;
  padding-left: 1.5rem;
}

</style>
