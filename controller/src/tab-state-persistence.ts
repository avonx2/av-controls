import type { Controls } from '@av-controls/protocol'

const DB_NAME = 'avonx-controller'
const DB_VERSION = 1
const STORE_NAME = 'tab-states'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })

  return dbPromise
}

export async function loadTabState(artworkName: string): Promise<Record<string, string>> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(artworkName)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result || {})
    })
  } catch (e) {
    console.warn('Failed to load tab state:', e)
    return {}
  }
}

export async function saveTabState(artworkName: string, tabStates: Record<string, string>): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put(tabStates, artworkName)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (e) {
    console.warn('Failed to save tab state:', e)
  }
}

function getControlPath(sender: Controls.Base.Sender): string {
  const parts: string[] = []
  let current: Controls.Base.Sender | undefined = sender
  while (current) {
    parts.unshift(current.spec.name)
    current = current.parent
  }
  return parts.join('.')
}

export function applyTabState(root: Controls.Base.Sender, state: Record<string, string>): void {
  root.deepForeach((sender) => {
    if (sender.spec.type === 'tabs') {
      const path = getControlPath(sender)
      const savedActiveId = state[path]
      const tabsSender = sender as Controls.Tabs.Sender
      if (savedActiveId && tabsSender.senders[savedActiveId]) {
        tabsSender.activeId = savedActiveId
      }
    }
  })
}

export function collectTabState(root: Controls.Base.Sender): Record<string, string> {
  const state: Record<string, string> = {}
  root.deepForeach((sender) => {
    if (sender.spec.type === 'tabs') {
      const path = getControlPath(sender)
      const tabsSender = sender as Controls.Tabs.Sender
      state[path] = tabsSender.activeId
    }
  })
  return state
}

function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), delay)
  }) as T
}

export function watchTabChanges(root: Controls.Base.Sender, artworkName: string): void {
  const debouncedSave = debounce(() => {
    const state = collectTabState(root)
    saveTabState(artworkName, state)
  }, 300)

  root.deepForeach((sender) => {
    if (sender.spec.type === 'tabs') {
      const tabsSender = sender as Controls.Tabs.Sender
      let currentActiveId = tabsSender.activeId
      Object.defineProperty(tabsSender, 'activeId', {
        get: () => currentActiveId,
        set: (value: string) => {
          currentActiveId = value
          debouncedSave()
        },
        configurable: true,
        enumerable: true,
      })
    }
  })
}
