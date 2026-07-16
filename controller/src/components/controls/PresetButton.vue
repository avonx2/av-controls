<script setup lang=ts>
import { computed } from 'vue'


// for color manipulation
import { Controls } from '@av-controls/protocol'


import Menu from '../../components/Menu.vue'

import { 
  menu, menuActionHandler, 
  textInputTitle, textInputPlaceholder, textInputHandler, 
  confirmTitle, confirmMessage, confirmHandler, 
  fileInputTitle, fileInputDescription, fileInputHandler, fileInputMergeOptionLabel,
  type MenuItemSpec 
} from '../../menu-globals'

import { ADJECTIVES, NOUNS } from './wordlists'

function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj} ${noun}`
}

function generateSuggestions(existingNames: string[]): string[] {
  const suggestions = new Set<string>()
  const maxAttempts = 100
  let attempts = 0
  while (suggestions.size < 3 && attempts < maxAttempts) {
    const name = generateRandomName()
    if (!existingNames.includes(name)) {
      suggestions.add(name)
    }
    attempts++
  }
  return Array.from(suggestions)
}

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
  const suggestions = generateSuggestions(presetNames)
  const items: MenuItemSpec[] = []
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
  }

  items.push({
    name: 'save',
    submenu: {
      name: 'Saving preset as ...',
      description: 'Overwrite a setting or save the current presets as a new file',
      items: [
        {
          name: 'type name',
          action: {
            type: 'save-as-prompt'
          },
          color: '#181',
        },
        ...suggestions.map(name => ({
          name,
          action: {
            type: 'save-as',
            name
          },
          color: '#336',
        })),
        ...presetNames.map(name => ({
          name: name,
          action: {
            type: 'save-as',
            name
          },
          color: '#952',
        })),
      ],
    },
  })

  if(presetNames.length > 0) {
    items.push(
      {
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
      },
      {
        name: 'rename',
        submenu: {
          name: 'Rename saved preset',
          description: 'Choose a preset and enter a new name.',
          items: presetNames.map(name => ({
            name,
            action: {
              type: 'rename-prompt',
              name
            }
          }))
        }
      }
    )
  }

  items.push(
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
    }
  )

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
    menu.value = null
    requestAnimationFrame(() => {
      props.presetButton.load(action.name)
    })
  } else if(action.type == 'delete') {
    confirmTitle.value = 'Delete preset'
    confirmMessage.value = `Do you really want to delete the preset "${action.name}"?`
    confirmHandler.value = (confirmed: boolean) => {
      if(!confirmed) {
        confirmHandler.value = undefined
        return
      }
      props.presetButton.deletePreset(action.name)
      confirmHandler.value = undefined
      menu.value = null
    }
  } else if(action.type == 'rename-prompt') {
    textInputTitle.value = `Rename preset "${action.name}"`
    textInputPlaceholder.value = 'new preset name'
    textInputHandler.value = (newPresetName) => {
      const trimmedName = newPresetName.trim()
      if(!trimmedName || trimmedName === action.name) {
        textInputHandler.value = undefined
        menu.value = null
        return
      }
      const renamePreset = () => {
        props.presetButton.renamePreset(action.name, trimmedName)
        textInputHandler.value = undefined
        confirmHandler.value = undefined
        menu.value = null
      }
      if(props.presetButton.getNames().includes(trimmedName)) {
        textInputHandler.value = undefined
        confirmTitle.value = 'Overwrite preset'
        confirmMessage.value = `A preset named "${trimmedName}" already exists. Overwrite it?`
        confirmHandler.value = (confirmed: boolean) => {
          if(confirmed) {
            renamePreset()
          } else {
            confirmHandler.value = undefined
          }
        }
      } else {
        renamePreset()
      }
    }
  } else if(action.type == 'import') {
    fileInputTitle.value = 'Import presets'
    fileInputDescription.value = 'Upload a presets file from your computer in order to import presets.'
    fileInputMergeOptionLabel.value = 'Merge with current presets'
    fileInputHandler.value = (file, options) => {
      const reader = new FileReader()
      reader.onload = (event) => {
        const presets = JSON.parse(event.target!.result as string)
        if(options.mergeWithExisting) {
          props.presetButton.mergePresets(presets)
        } else {
          props.presetButton.setPresets(presets)
        }
      }
      reader.readAsText(file)
      fileInputHandler.value = undefined
      fileInputMergeOptionLabel.value = ''
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
