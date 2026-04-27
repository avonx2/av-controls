<script setup lang=ts>
import { computed, ref } from 'vue'


// for color manipulation
import { Controls } from 'av-controls'


// vue
const props = defineProps({
  textbox: {
    type: Object as () => Controls.Textbox.Sender,
    required: true,
  },
})

const basisStyle = computed(() => {
  const spec = props.textbox.spec
  return {
    backgroundColor: spec.color,
    boxShadow: `0 0 2rem -0.5rem ${spec.color}`,
    borderColor: spec.color,
  }
})

const inputRef = ref<HTMLInputElement | null>(null)

function update() {
  props.textbox.text = inputRef.value?.value || ''
  props.textbox.send()
}

</script>

<template>
  <div
    class="basis"
    :style=basisStyle
    :tabindex="0"
    >
      <textarea
        class="container"
        ref="inputRef"
        :v-bind="props.textbox.text"
        @blur="update"
      />
  </div>
  <div class="label-top" >
    {{ props.textbox.spec.name }}
  </div>
</template>

<style scoped>
@import './control-styles.css';

.basis {
  cursor: default;


  & .container{
    background-color: #0008;
    outline: none;
    color: #fff; 
    position: relative;
    margin-top: 1.1rem; 
    height: calc(100% - 1.1rem);
    text-align: center;
    width: calc(100%);
    font-size: 2rem; 
    overflow: hidden;
    &:focus {
      border: 0.2rem solid white; 
    }

    & .lasttext {
      position: absolute; 
      color: #fff8; 
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      vertical-align: middle;
      font-size: 7rem;
      text-align: center;
      font-weight: bold;
      pointer-events: none;
    }
  }
}
</style>
