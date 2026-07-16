<script lang="ts">
const menuInstanceStack: symbol[] = []
</script>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

import { type MenuSpec, type MenuItemSpec } from '../menu-globals';

const props = defineProps({
  menu: {
    type: Object as () => MenuSpec,
    required: true,
  }, 
});

const emit = defineEmits(['back', 'action']);

const activeSubmenu = ref(null as MenuSpec | null);
const menuInstance = Symbol('menu-instance');

function handleClick(item: MenuItemSpec) {
  if (item.submenu) {
    activeSubmenu.value = item.submenu;
  } else if (item.action) {
    emit('action', item.action);
  }
}

function goBack() {
  emit('back');
}

function performAction(action: any) {
  emit('action', action);
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (menuInstanceStack[menuInstanceStack.length - 1] !== menuInstance) {
      return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
    if (activeSubmenu.value !== null) {
      activeSubmenu.value = null
    } else {
      goBack();
    }
  }
}

onMounted(() => {
  menuInstanceStack.push(menuInstance)
  window.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  const index = menuInstanceStack.indexOf(menuInstance)
  if (index !== -1) {
    menuInstanceStack.splice(index, 1)
  }
  window.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <Menu 
    v-if=activeSubmenu 
    :menu="activeSubmenu" 
    @back="activeSubmenu = null" 
    @action="performAction" />
  <div v-else class="popup">
    <div class="menu">
      <h3>{{ props.menu.name }}</h3>
      <p class="description">{{ props.menu.description }}</p>
      <div class="buttonGrid">
        <button class="menuItem exitButton" @click="goBack">Back</button>
        <button class=menuItem tabindex="0" @click="handleClick(item)" v-for="(item, index) in props.menu.items" :key="index"
                                                                    :style="{backgroundColor: item.color}">
          {{ item.name }} 
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.popup {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
}
.menu {
  position: absolute;
  /* center the menu */
  top: 3rem; 
  left: 3rem; 
  right: 3rem;
  bottom: 3rem; 
  box-shadow: 0 0 3rem rgba(0, 0, 0, 1);
  background-color: #151515; 
  padding: 2rem;
  box-sizing: border-box;
  border-radius: 1rem; 
  border: 0.5rem solid #222;
  overflow-y: auto;
}
.description {
  color: #bbb;
}
.buttonGrid {
  /* min size of items 8rem */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  gap: 1rem;
  justify-content: center;
  align-items: center;
  width: 100%;
}
.menuItem {
  aspect-ratio: 1;
  display: inline-block;
  text-align: center;
  vertical-align: middle; 
}
.exitButton {
  background-color: #922;
}
</style>
