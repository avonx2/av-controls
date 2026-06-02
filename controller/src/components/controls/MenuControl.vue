<script setup lang="ts">
import { computed, ref } from 'vue'
import { shade, lighten } from 'polished'
import { Controls } from '@av-controls/protocol'

const props = defineProps({
  menu: {
    type: Object as () => Controls.Menu.Sender,
    required: true,
  },
})

const isOpen = ref(false)
const isPressed = ref(false)

const basisStyle = computed(() => {
  const color = props.menu.spec.color
  return {
    backgroundColor: isPressed.value ? shade(0.35, color) : color,
    boxShadow: `0 0 3rem -2rem ${color}`,
    borderColor: color,
  }
})

const selectedColor = computed(() => {
  return shade(0.3, props.menu.spec.color)
})

const optionColor = computed(() => {
  return lighten(0.1, props.menu.spec.color)
})

function openMenu(e: TouchEvent | MouseEvent) {
  props.menu.onTouch()
  isPressed.value = true
  isOpen.value = true
  e.preventDefault()
}

function selectOption(e: TouchEvent | MouseEvent, index: number) {
  props.menu.select(index)
  isOpen.value = false
  isPressed.value = false
  e.preventDefault()
}

function closeMenu(e: TouchEvent | MouseEvent) {
  isOpen.value = false
  isPressed.value = false
  e.preventDefault()
}
</script>

<template>
  <div
    class="basis"
    :style="basisStyle"
    @touchstart="openMenu"
    @mousedown="openMenu"
  >
  </div>
  <div class="centered-label">{{ props.menu.spec.name }}</div>

  <!-- Modal overlay -->
  <Teleport to="body" v-if="isOpen">
    <div class="menu-overlay" @touchstart="closeMenu" @mousedown="closeMenu">
      <div class="menu-modal" @touchstart.stop @mousedown.stop>
        <h3>{{ props.menu.spec.name }}</h3>
        <p v-if="props.menu.description" class="menu-description">
          {{ props.menu.description }}
        </p>
        <div class="menu-options">
          <button
            v-for="(option, index) in props.menu.options"
            :key="index"
            class="menu-option"
            :style="{
              backgroundColor: index === props.menu.selectedIndex ? selectedColor : optionColor
            }"
            @touchstart="selectOption($event, index)"
            @mousedown="selectOption($event, index)"
          >
            {{ option }}
          </button>
        </div>
        <button class="menu-close" @touchstart="closeMenu" @mousedown="closeMenu">
          Close
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
@import './control-styles.css';

.menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  z-index: 1000;
  display: flex;
  justify-content: center;
  align-items: center;
}

.menu-modal {
  background: #333;
  padding: 1.5rem;
  border-radius: 1rem;
  border: 0.3rem solid #555;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
  min-width: 300px;
}

.menu-modal h3 {
  margin: 0 0 0.5rem 0;
  color: #fff;
  text-align: center;
}

.menu-description {
  color: #aaa;
  text-align: center;
  margin: 0 0 1rem 0;
  font-size: 0.9em;
}

.menu-options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.menu-option {
  padding: 1rem;
  border: none;
  border-radius: 0.5rem;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
  text-align: center;
  user-select: none;
}

.menu-option:active {
  opacity: 0.8;
}

.menu-close {
  width: 100%;
  padding: 0.8rem;
  background: #666;
  border: none;
  border-radius: 0.5rem;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}

.menu-close:active {
  background: #555;
}
</style>
