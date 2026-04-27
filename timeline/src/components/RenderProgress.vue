<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{
  frameNumber: number
  totalFrames: number
  currentTime: number
  testMode: boolean
}>()

const emit = defineEmits<{
  continue: []
  cancel: []
}>()

const startTime = ref(Date.now())
const showContinueDialog = ref(false)

const progressPercent = computed(() => {
  if (props.totalFrames === 0) return 0
  return Math.min(100, (props.frameNumber / props.totalFrames) * 100)
})

const estimatedRemaining = computed(() => {
  if (props.frameNumber === 0) return null
  const elapsed = Date.now() - startTime.value
  const msPerFrame = elapsed / props.frameNumber
  const framesLeft = props.totalFrames - props.frameNumber
  return msPerFrame * framesLeft
})

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

// Watch for test mode completion
watch(() => props.frameNumber, (newFrame) => {
  if (props.testMode && newFrame >= 3 && !showContinueDialog.value) {
    showContinueDialog.value = true
  }
})
</script>

<template>
  <div class="render-progress-overlay">
    <div class="render-progress" v-if="!showContinueDialog">
      <h2>{{ testMode ? 'Rendering Test Frames...' : 'Rendering...' }}</h2>

      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>

      <div class="progress-info">
        <p class="frame-count">Frame {{ frameNumber }} / {{ totalFrames }}</p>
        <p class="time-info">Time: {{ currentTime.toFixed(2) }}s</p>
        <p v-if="estimatedRemaining && !testMode" class="eta">ETA: {{ formatTime(estimatedRemaining) }}</p>
      </div>

      <button @click="emit('cancel')" class="cancel-btn">Cancel</button>
    </div>

    <div class="render-progress continue-dialog" v-else>
      <h2>Test Complete</h2>

      <div class="test-summary">
        <p>✓ Rendered 3 test frames successfully</p>
        <p class="hint">Check your downloads folder for the test frames</p>
      </div>

      <div class="continue-actions">
        <button @click="emit('cancel')" class="action-btn">Stop</button>
        <button @click="emit('continue')" class="action-btn action-btn-primary">Continue with Full Render</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.render-progress-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.render-progress {
  background: rgba(20, 22, 28, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 0.5rem;
  padding: 2rem;
  max-width: 500px;
  width: 90%;
  text-align: center;

  & h2 {
    margin: 0 0 1.5rem 0;
    color: #fff;
    font-size: 1.5rem;
  }
}

.progress-bar {
  width: 100%;
  height: 24px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 1.5rem;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(100, 150, 255, 0.8), rgba(100, 200, 255, 0.8));
  transition: width 0.3s ease;
  border-radius: 12px;
}

.progress-info {
  margin-bottom: 1.5rem;

  & p {
    margin: 0.5rem 0;
    color: rgba(255, 255, 255, 0.9);
    font-size: 0.95rem;
  }

  & .frame-count {
    font-size: 1.1rem;
    font-weight: 500;
  }

  & .time-info {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
  }

  & .eta {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.85rem;
  }
}

.cancel-btn {
  padding: 0.75rem 2rem;
  background: rgba(255, 80, 80, 0.2);
  border: 1px solid rgba(255, 80, 80, 0.4);
  border-radius: 0.3rem;
  color: #fff;
  font-size: 0.95rem;
  cursor: pointer;

  &:hover {
    background: rgba(255, 80, 80, 0.3);
  }
}

.continue-dialog {
  & .test-summary {
    margin-bottom: 1.5rem;

    & p {
      margin: 0.75rem 0;
      color: rgba(255, 255, 255, 0.9);
      font-size: 1rem;
    }

    & .hint {
      color: rgba(255, 255, 255, 0.6);
      font-size: 0.85rem;
    }
  }

  & .continue-actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
  }

  & .action-btn {
    padding: 0.75rem 1.5rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 0.3rem;
    color: #fff;
    font-size: 0.95rem;
    cursor: pointer;

    &:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    &.action-btn-primary {
      background: rgba(100, 150, 255, 0.3);
      border-color: rgba(100, 150, 255, 0.5);

      &:hover {
        background: rgba(100, 150, 255, 0.4);
      }
    }
  }
}
</style>
