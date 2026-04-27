<script setup lang="ts">
import { computed, ref, watch } from 'vue'

type SearchableControl = {
  id: string
  name: string
}

const props = defineProps<{
  controls: SearchableControl[]
}>()

const emit = defineEmits<{
  select: [rowId: string]
}>()

const controlSearch = ref('')
const highlightedSearchIndex = ref(0)
const showSearchResults = ref(false)

type IndexedControl = {
  control: SearchableControl
  path: string
  pathParts: string[]
  name: string
  nameTokens: string[]
}

const indexedControls = computed<IndexedControl[]>(() =>
  props.controls.map((control) => {
    const path = control.id.toLowerCase()
    const pathParts = path.split('.').filter(Boolean)
    const name = control.name.toLowerCase()
    const nameTokens = splitTokens(name)
    return {
      control,
      path,
      pathParts,
      name,
      nameTokens,
    }
  }),
)

const controlSearchResults = computed(() => {
  const query = controlSearch.value.trim()
  if (!query) return []

  const normalizedQuery = query.toLowerCase()
  const queryTokens = splitTokens(normalizedQuery)

  return indexedControls.value
    .map((entry) => ({
      control: entry.control,
      score: scoreIndexedControl(normalizedQuery, queryTokens, entry),
    }))
    .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.control.id.localeCompare(b.control.id)
    })
    .slice(0, 10)
    .map((entry) => entry.control)
})

watch(controlSearchResults, (results) => {
  if (!results.length) {
    highlightedSearchIndex.value = 0
    return
  }
  if (highlightedSearchIndex.value >= results.length) {
    highlightedSearchIndex.value = 0
  }
})

function splitTokens(value: string) {
  return value
    .split(/[^a-z0-9]+/i)
    .map(token => token.trim())
    .filter(Boolean)
}

function fuzzySubsequenceScore(query: string, candidate: string) {
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()

  let score = 0
  let lastMatchIndex = -1
  let searchIndex = 0

  for (const char of q) {
    const foundIndex = c.indexOf(char, searchIndex)
    if (foundIndex === -1) return Number.NEGATIVE_INFINITY
    score += 1
    if (lastMatchIndex !== -1 && foundIndex === lastMatchIndex + 1) {
      score += 4
    }
    if (foundIndex === 0 || '. _-/'.includes(c[foundIndex - 1] ?? '')) {
      score += 3
    }
    if (c.startsWith(q)) {
      score += 8
    }
    lastMatchIndex = foundIndex
    searchIndex = foundIndex + 1
  }

  score -= c.length * 0.01
  return score
}

function bestTokenScore(query: string, tokens: string[]) {
  let best = Number.NEGATIVE_INFINITY
  for (const token of tokens) {
    if (token === query) {
      best = Math.max(best, 220 - token.length * 0.01)
      continue
    }
    if (token.startsWith(query)) {
      best = Math.max(best, 160 - token.length * 0.01)
      continue
    }
    if (token.includes(query)) {
      best = Math.max(best, 100 - token.length * 0.01)
      continue
    }
    best = Math.max(best, fuzzySubsequenceScore(query, token))
  }
  return best
}

function scoreIndexedControl(query: string, queryTokens: string[], entry: IndexedControl) {
  let score = Number.NEGATIVE_INFINITY

  if (entry.name === query) score = Math.max(score, 1200)
  if (entry.name.startsWith(query)) score = Math.max(score, 900 - entry.name.length * 0.1)
  if (entry.name.includes(query)) score = Math.max(score, 760 - entry.name.length * 0.05)

  const nameTokenScore = bestTokenScore(query, entry.nameTokens)
  if (nameTokenScore > Number.NEGATIVE_INFINITY) {
    score = Math.max(score, 600 + nameTokenScore)
  }

  const leafPathPart = entry.pathParts[entry.pathParts.length - 1] ?? entry.path
  const leafScore = fuzzySubsequenceScore(query, leafPathPart)
  if (leafScore > Number.NEGATIVE_INFINITY) {
    score = Math.max(score, 500 + leafScore)
  }

  if (entry.path === query) score = Math.max(score, 420)
  if (entry.path.startsWith(query)) score = Math.max(score, 330 - entry.path.length * 0.02)
  if (entry.path.includes(query)) score = Math.max(score, 250 - entry.path.length * 0.01)

  const pathPartScore = bestTokenScore(query, entry.pathParts)
  if (pathPartScore > Number.NEGATIVE_INFINITY) {
    score = Math.max(score, 200 + pathPartScore)
  }

  const pathScore = fuzzySubsequenceScore(query, entry.path)
  if (pathScore > Number.NEGATIVE_INFINITY) {
    score = Math.max(score, 120 + pathScore)
  }

  if (score === Number.NEGATIVE_INFINITY) return score

  for (const token of queryTokens) {
    if (entry.nameTokens.includes(token)) {
      score += 120
      continue
    }
    if (entry.pathParts.includes(token)) {
      score += 40
      continue
    }
    const nameTokenMatch = entry.nameTokens.some(candidate => candidate.includes(token))
    const pathTokenMatch = entry.pathParts.some(candidate => candidate.includes(token))
    if (nameTokenMatch) {
      score += 70
    } else if (pathTokenMatch) {
      score += 20
    } else {
      return Number.NEGATIVE_INFINITY
    }
  }

  return score
}

function clearControlSearch() {
  controlSearch.value = ''
  highlightedSearchIndex.value = 0
  showSearchResults.value = false
}

function onControlSearchInput(event: Event) {
  controlSearch.value = (event.target as HTMLInputElement).value
  highlightedSearchIndex.value = 0
  showSearchResults.value = !!controlSearch.value.trim()
}

function selectControl(controlId: string) {
  emit('select', controlId)
  clearControlSearch()
}

function onControlSearchKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    clearControlSearch()
    return
  }

  const results = controlSearchResults.value
  if (!showSearchResults.value || !results.length) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    highlightedSearchIndex.value = (highlightedSearchIndex.value + 1) % results.length
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    highlightedSearchIndex.value = (highlightedSearchIndex.value - 1 + results.length) % results.length
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    const selected = results[highlightedSearchIndex.value]
    if (selected) selectControl(selected.id)
  }
}

function onControlSearchBlur() {
  window.setTimeout(() => {
    showSearchResults.value = false
  }, 100)
}

function onControlSearchFocus() {
  showSearchResults.value = !!controlSearch.value.trim() && controlSearchResults.value.length > 0
}
</script>

<template>
  <div class="control-search">
    <input
      :value="controlSearch"
      class="input control-search-input"
      type="text"
      placeholder="search controls"
      spellcheck="false"
      @input="onControlSearchInput"
      @keydown="onControlSearchKeydown"
      @focus="onControlSearchFocus"
      @blur="onControlSearchBlur"
    />
    <div v-if="showSearchResults && controlSearchResults.length" class="control-search-results">
      <button
        v-for="(control, index) in controlSearchResults"
        :key="control.id"
        class="control-search-result"
        :class="{ active: index === highlightedSearchIndex }"
        type="button"
        @mousedown.prevent="selectControl(control.id)"
      >
        <span class="control-search-result-id">{{ control.id }}</span>
        <span v-if="control.name !== control.id" class="control-search-result-name">{{ control.name }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.control-search {
  position: relative;
  flex: 1 1 11rem;
  min-width: 7.5rem;
  max-width: 15rem;
}

.control-search-input {
  width: 100%;
  min-width: 0;
  padding: 0.42rem 0.72rem;
  font-size: 0.85rem;
  line-height: 1.1;
  color: rgba(243, 242, 238, 0.94);
  background:
    linear-gradient(180deg, rgba(34, 47, 67, 0.92), rgba(26, 31, 43, 0.96));
  border: 1px solid rgba(255, 255, 255, 0.11);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 1px 0 rgba(0, 0, 0, 0.18);
}

.control-search-input::placeholder {
  color: rgba(243, 242, 238, 0.42);
}

.control-search-input:focus {
  outline: none;
  border-color: rgba(123, 220, 255, 0.42);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 0 0 1px rgba(123, 220, 255, 0.12);
}

.control-search-results {
  position: absolute;
  top: calc(100% + 0.3rem);
  left: 0;
  width: min(28rem, 70vw);
  max-height: 20rem;
  overflow: auto;
  background:
    linear-gradient(180deg, rgba(21, 28, 39, 0.98), rgba(14, 18, 26, 0.98));
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0.7rem;
  padding: 0.35rem;
  box-shadow: 0 0.8rem 2rem rgba(0, 0, 0, 0.3);
  z-index: 20;
}

.control-search-result {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.45rem 0.55rem;
  background: transparent;
  border: none;
  color: inherit;
  border-radius: 0.45rem;
  cursor: pointer;
  text-align: left;
}

.control-search-result.active,
.control-search-result:hover {
  background: rgba(123, 220, 255, 0.14);
}

.control-search-result-id {
  color: rgba(243, 242, 238, 0.96);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.control-search-result-name {
  color: rgba(243, 242, 238, 0.55);
  white-space: nowrap;
}
</style>
