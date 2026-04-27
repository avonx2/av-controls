<script setup lang=ts>
import { type SendersDict } from 'av-controls'
import ControlComponent from './Control.vue'

// vue
const props = defineProps({
  controls: {
    type: Object as () => SendersDict, 
    required: true,
  }
})

</script>

<template>
  <ControlComponent :control="control" v-for="(control, id) in props.controls" :key="id" />
</template>

<style scoped>
</style>
