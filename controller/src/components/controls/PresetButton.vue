<script setup lang=ts>
import { computed } from 'vue'


// for color manipulation
import { Controls } from '@av-controls/protocol'


import Menu from '../../components/Menu.vue'

import { 
  menu, menuActionHandler, 
  textInputTitle, textInputPlaceholder, textInputHandler, 
  confirmTitle, confirmMessage, confirmHandler, 
  fileInputTitle, fileInputDescription, fileInputHandler, 
  type MenuItemSpec 
} from '../../menu-globals'

// vue
const props = defineProps({
  presetButton: {
    type: Object as () => Controls.PresetButton.Sender,
    required: true,
  },
})

const basisStyle = computed(() => {
  const spec = props.presetButton.spec
  return {
    backgroundColor: spec.color,
    boxShadow: `0 0 2rem -0.5rem ${spec.color}`,
    borderColor: spec.color,
  }
})

function openMenu(_e: Event) {
  const presetNames = props.presetButton.getNames()
  const items = [
    {
      name: 'save',
      submenu: {
        name: 'Saving preset as ...', 
        description: 'Overwrite a setting or save the current presets as a new file',
        items: [
          ...presetNames.map(name => ({
            name: name,
            action: {
              type: 'save-as', 
              name
            }, 
            color: '#ea8',
          })),
          ...Array.from({length: 8}, (_, i) => i).filter(i => !presetNames.includes(`${i}`)).map(i => ({
            name: `${i}`,
            action: {
              type: 'save-as',
              name: `${i}`
            },
          })),
          {
            name: 'individual name', 
            action: {
              type: 'save-as-prompt'
            },
            color: '#8f8',
          },
        ],
      },
    },
    {
      name: 'import',
      action: {
        type: 'import'
      }
    },
    {
      name: 'export',
      action: {
        type: 'export'
      }
    },
  ] as MenuItemSpec[]
  if(presetNames.length > 0) {
    items.push({
      name: 'load',
      submenu: {
        name: 'Load saved preset', 
        description: 'Load a saved preset. This will override the currently active mapping', 
        items: presetNames.map(name => ({
          name, 
          action: {
            type: 'load', 
            name
          }
        }))
      }
    })
    items.push({
      name: 'delete',
      submenu: {
        name: 'Delete saved preset', 
        description: 'Delete a preset. This cannot be undone and the mapping can\'t be loaded anymore afterwards.', 
        items: presetNames.map(name => ({
          name, 
          action: {
            type: 'delete', 
            name
          }
        }))
      }
    })
  } 

  menu.value = {
    name: `${props.presetButton.spec.name}`,
    description: 'save, load and remove presets', 
    items
  };
  menuActionHandler.value = handleMenuAction
}


function handleMenuAction(action: any) {
  if(action.type == 'save-as-prompt') {
    textInputTitle.value = 'Enter the name for the new preset'
    textInputPlaceholder.value = 'new preset name'
    textInputHandler.value = (newPresetName) => {
      props.presetButton.save(newPresetName)
      textInputHandler.value = undefined
      menu.value = null
    }
  } else if(action.type == 'save-as') {
    props.presetButton.save(action.name)
    menu.value = null
  } else if(action.type == 'load') {
    props.presetButton.load(action.name)
    menu.value = null
  } else if(action.type == 'delete') {
    confirmTitle.value = 'Delete preset'
    confirmMessage.value = `Do you really want to delete the preset "${action.name}"?`
    confirmHandler.value = () => {
      props.presetButton.deletePreset(action.name)
      confirmHandler.value = undefined
      menu.value = null
    }
  } else if(action.type == 'import') {
    fileInputTitle.value = 'Import presets'
    fileInputDescription.value = 'Upload a presets file from your computer in order to import presets'
    fileInputHandler.value = (file) => {
      const reader = new FileReader()
      reader.onload = (event) => {
        const presets = JSON.parse(event.target!.result as string)
        props.presetButton.setPresets(presets)
      }
      reader.readAsText(file)
      fileInputHandler.value = undefined
      menu.value = null
    }
  } else if(action.type == 'export') {
    const presets = props.presetButton.getAllPresets()
    const blob = new Blob([JSON.stringify(presets)], {type: 'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const filename = props.presetButton.spec.name.replace(' ', '-')
    a.download = `${filename}.json`
    a.click()
    URL.revokeObjectURL(url)
    menu.value = null
  }
}

const loaded = computed(() => props.presetButton.getLoadedPreset())

</script>

<template>
  <div
    class="basis"
    :style=basisStyle
    :tabindex="props.presetButton.tabIndex()"
    @click="openMenu"
    >
  </div>
  <div class="centered-label" >
    {{ props.presetButton.spec.name }}<span v-if="loaded !== undefined">, loaded: {{ loaded }}</span>
  </div>
  <Menu 
    v-if="menu" 
    :menu="menu" 
    @back="menu = null"
    @action="handleMenuAction" />
</template>

<style scoped>
@import './control-styles.css';

</style>
