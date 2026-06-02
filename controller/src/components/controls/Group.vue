<script setup lang=ts>
import { computed } from 'vue'

import Area from './Area.vue'

import { Controls } from '@av-controls/protocol'
import { shade } from 'polished';

// vue
const props = defineProps({
  group: {
    type: Object as () => Controls.Group.Sender,
    required: true,
  },
})

const controls = computed(() => props.group.senders)

// const basisStyle = makeBasisStyle(props.group.spec) 
const basisStyle = computed(() => {
  const color = props.group.spec.color
  return {
    backgroundColor: shade(0.5, color),
    borderColor: color,
  }
})

</script>

<template>
  <div>
    <Area :controls=controls />
  </div>
</template>

<style scoped>
@import './control-styles.css';

</style>
