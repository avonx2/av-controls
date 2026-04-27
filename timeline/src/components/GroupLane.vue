<script setup lang="ts">
const props = defineProps<{
  width: number
  height: number
  lineCount: number
}>()

function getLineY(index: number) {
  const count = Math.max(1, Math.min(5, props.lineCount))
  const spacing = props.height / (count + 1)
  return spacing * (index + 1)
}
</script>

<template>
  <svg
    class="group-lane"
    :viewBox="`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <line
      v-for="index in Math.max(1, Math.min(5, lineCount))"
      :key="index"
      class="group-line"
      x1="0"
      :y1="getLineY(index - 1)"
      :x2="Math.max(1, width)"
      :y2="getLineY(index - 1)"
    />
  </svg>
</template>

<style scoped>
.group-lane {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.group-line {
  stroke: rgba(235, 130, 52, 0.9);
  stroke-width: 1;
}
</style>
