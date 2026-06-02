import type { Controls } from '@av-controls/protocol'

const DB_NAME = '@av-controls/protocol'
const STORE_NAME = 'controller-visual-state'
const DB_VERSION = 2
const debounceMs = 400

type StoredVisualState = {
  state: Controls.Base.State
  timestamp: number
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function cloneState(state: Controls.Base.State): Controls.Base.State {
  return JSON.parse(JSON.stringify(state)) as Controls.Base.State
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('control-state')) {
        db.createObjectStore('control-state')
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

export async function loadControlStateSnapshot(artworkId: string): Promise<Controls.Base.State | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(artworkId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const stored = request.result as StoredVisualState | undefined
      resolve(stored?.state ? cloneState(stored.state) : null)
    }
    transaction.oncomplete = () => db.close()
  })
}

export function scheduleControlStateSnapshotSave(artworkId: string, state: Controls.Base.State): void {
  const existing = saveTimers.get(artworkId)
  if (existing) {
    clearTimeout(existing)
  }

  const snapshot = cloneState(state)
  const timer = setTimeout(() => {
    saveTimers.delete(artworkId)
    void saveControlStateSnapshot(artworkId, snapshot)
  }, debounceMs)
  saveTimers.set(artworkId, timer)
}

async function saveControlStateSnapshot(artworkId: string, state: Controls.Base.State): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const stored: StoredVisualState = {
      state,
      timestamp: Date.now(),
    }
    const request = store.put(stored, artworkId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
    transaction.oncomplete = () => db.close()
  })
}
