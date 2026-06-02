<script setup lang=ts>
import { computed } from 'vue'

import { Controls } from '@av-controls/protocol'
import { shade } from 'polished';

import Control from './Control.vue'

// vue
const props = defineProps({
  tabs: {
    type: Object as () => Controls.Tabs.Sender,
    required: true,
  },
})

const tabs = computed(() => {
  const tabNames = Object.keys(props.tabs.senders)
  return tabNames.map(name => {
    const tabColor = props.tabs.senders[name]?.spec?.color ?? props.tabs.spec.color
    return {
      name,
      backgroundColor: props.tabs.activeId == name ? shade(0.5, tabColor) : tabColor,
    }
  })
})

const basisStyle = computed(() => {
  const activeColor = props.tabs.senders[props.tabs.activeId]?.spec?.color
  const color = activeColor ?? props.tabs.spec.color
  return {
    backgroundColor: shade(0.5, color),
    borderColor: props.tabs.spec.color,
  }
})

</script>

<template>
  <div class="basis framed any" :style="basisStyle" >
    <div class="header" :style="{ backgroundColor: props.tabs.spec.color }">
      <div v-for="tab in tabs" 
        :class="{tabButton: true, active: tab.name === props.tabs.activeId}"
        :key="tab.name"  
        @click="props.tabs.activeId = tab.name" 
        :style="{ backgroundColor: tab.backgroundColor }">
        {{ tab.name }}
      </div>
    </div>
    <div class="content any">
      <Control
        v-if="props.tabs.senders[props.tabs.activeId]"
        :key="props.tabs.activeId"
        :control="props.tabs.senders[props.tabs.activeId]!"
      />
    </div>
  </div>
</template>

<style scoped>
@import './control-styles.css';
.any {
  cursor: default; 
}

.page {
  position: absolute;
  margin: .5rem; 
  width: calc(100% - 1rem);
  height: calc(100% - 1rem);
}

.framed {
  display: flex;
  flex-direction: column;

  & .header {
    width: 100%;
    text-align: center;
    user-select: none;
    display: flex;
    justify-content: space-around;

    /* tab buttons should be as wide as possible, given all the space they need. larger text should make the button wider */
    & .tabButton {
      flex: auto; 
      padding: 1rem 0.2rem;
      cursor: pointer;
      border-top-left-radius: 0.5rem;
      border-top-right-radius: 0.5rem;
    }
  }
  & .content {
    margin:0; 
    position: relative;
    flex: 1;
  }
}

</style>
