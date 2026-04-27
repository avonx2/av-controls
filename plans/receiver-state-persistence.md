# Receiver-side State Persistence

## Overview
Persist control state in IndexedDB on the artwork side, keyed by `artworkId/controlPath`. State restores automatically on reload, with per-control debounced saves.

## Implementation Steps

### 1. Sanitize control names in `base.ts`
- In `Args` constructor or `Spec` constructor, replace `/` with `-` in `name`
- Log warning if replacement occurs
- Prevents path separator conflicts

### 2. Add state methods to Receiver classes

**In `base.ts`:**
```typescript
export abstract class Receiver {
  // ... existing ...

  getState(): State {
    return new State()  // Override in subclasses with state
  }

  restoreState(_state: State): void {
    // Override in subclasses - sets value WITHOUT triggering onUpdate
  }
}
```

**For each control with state (fader, knob, switch, joystick, selector, dots, textbox, letterbox):**
```typescript
// Example for Fader
getState(): State {
  return new State(this.value)
}

restoreState(state: State): void {
  this.value = state.value
  if (this.onChange) this.onChange(this.value)  // Notify artwork
  // Note: does NOT call onUpdate - avoids persistence loop
}
```

**For Group/Modal:** recursively restore children's states

### 3. Create `persistence.ts` module

```typescript
// protocol/src/persistence.ts

const DB_NAME = 'av-controls'
const STORE_NAME = 'control-state'
const DB_VERSION = 1

interface StoredState {
  state: any  // The control's State object
  timestamp: number
}

export interface PersistenceOptions {
  enabled?: boolean      // default: true
  artworkId: string      // required
  debounceMs?: number    // default: 500
}

export class StatePersistence {
  private db: IDBDatabase | null = null
  private debounceTimers = new Map<string, number>()
  private options: Required<PersistenceOptions>

  constructor(options: PersistenceOptions) {
    this.options = {
      enabled: options.enabled ?? true,
      artworkId: options.artworkId,
      debounceMs: options.debounceMs ?? 500
    }
  }

  async init(): Promise<void>
  // Opens IndexedDB, creates object store if needed

  async loadState(): Promise<Map<string, any>>
  // Returns Map of controlPath -> state for this artworkId
  // Query: all keys starting with `${artworkId}/`

  scheduleWrite(controlPath: string, state: any): void
  // Per-control debounced write:
  // - Cancel existing timer for this path
  // - Start new timer
  // - On timeout: write to IndexedDB

  private async writeState(controlPath: string, state: any): Promise<void>
  // Key: `${artworkId}/${controlPath}`
  // Value: { state, timestamp: Date.now() }

  close(): void
  // Clean up timers, close DB
}
```

### 4. Utility: Extract path and state from nested Update

```typescript
// In persistence.ts or utils

export function extractUpdatePath(update: Base.Update): { path: string[], state: any } | null {
  // Walk nested Group.Update to extract:
  // - path: ["group1", "effects", "blur"]
  // - state: the leaf control's state

  const path: string[] = []
  let current = update

  while (current instanceof Group.Update) {
    path.push(current.controlId)
    current = current.update
  }

  // current is now the leaf update (Fader.Update, etc.)
  // Convert update to state format
  const state = updateToState(current)
  if (!state) return null

  return { path, state }
}
```

### 5. Modify transport receivers

**Window.Receiver and WebSocket.Receiver constructors:**
```typescript
constructor(
  // ... existing params ...
  private persistenceOptions?: PersistenceOptions
) {
  // ... existing init ...

  if (persistenceOptions?.enabled !== false) {
    this.persistence = new StatePersistence(persistenceOptions)
    this.initWithPersistence()
  } else {
    this.initWithoutPersistence()
  }
}

private async initWithPersistence() {
  await this.persistence.init()
  const storedState = await this.persistence.loadState()

  // Apply stored state to receivers
  this.applyStoredState(storedState)

  // Now send RootSpecification (with restored values)
  this.sendSpec()

  // Hook onUpdate for persistence
  const originalOnUpdate = this.rootReceiver.onUpdate
  this.rootReceiver.onUpdate = (update) => {
    originalOnUpdate(update)
    this.persistUpdate(update)
  }
}

private applyStoredState(storedState: Map<string, any>) {
  // Walk receiver tree, apply matching stored states
  walkReceivers(this.rootReceiver, [], (path, receiver) => {
    const key = path.join('/')
    const state = storedState.get(key)
    if (state) {
      receiver.restoreState(state)
    }
  })
}

private persistUpdate(update: Base.Update) {
  const extracted = extractUpdatePath(update)
  if (extracted) {
    const pathKey = extracted.path.join('/')
    this.persistence.scheduleWrite(pathKey, extracted.state)
  }
}
```

### 6. Export from protocol index

```typescript
// src/index.ts
export * as Persistence from './persistence'
```

## File Changes Summary

| File | Changes |
|------|---------|
| `src/controls/base.ts` | Add `getState()`, `restoreState()` to Receiver; sanitize `/` in names |
| `src/controls/*.ts` | Implement `getState()`, `restoreState()` for each control with state |
| `src/persistence.ts` | **New file** - IndexedDB wrapper, per-control debouncing |
| `src/transports/window.ts` | Add persistence options, restore on init, persist on update |
| `src/transports/websocket.ts` | Same as window transport |
| `src/index.ts` | Export Persistence module |

## Usage (artwork side)

### Window Transport
```typescript
import { Transports } from 'av-controls'

const receiver = new Transports.Window.Receiver(
  controllerWindow,
  'my-artwork',
  rootControlReceiver,
  timeline,
  { artworkId: 'my-artwork-v1' }  // enables persistence
)

// Wait for persistence to be ready (optional but recommended)
await receiver.ready

// Or disable persistence:
// { artworkId: 'my-artwork', enabled: false }
```

### WebSocket Transport (multiple panels)
```typescript
import { Transports } from 'av-controls'

const receiver = new Transports.WebSocket.Receiver(
  { 'panel1': receiver1, 'panel2': receiver2 },
  'ws://localhost:8080',
  { autoReconnect: true },
  { 'panel1': timeline1, 'panel2': timeline2 },  // timelines
  {
    'panel1': { artworkId: 'artwork1' },
    'panel2': { artworkId: 'artwork2' },
  }  // persistence options per panel
)

await receiver.ready
```

### Control Spec Changes (breaking!)
```typescript
// Before (v0.4.0)
new Fader.Spec(args, 0.5, 0, 1, 2)

// After (v0.5.0)
new Fader.Spec(args, new Fader.State(0.5), 0, 1, 2)

// Joystick
new Joystick.Spec(args, new Joystick.State(0, 0))

// Switch
new Switch.Spec(args, new Switch.State(true))
```

## Edge Cases

- **First load:** No stored state, uses spec's `initialState`
- **Spec changes:** Unknown stored keys are ignored; missing keys use defaults
- **Rapid changes:** Per-control debounce ensures max ~2 writes/sec per control
- **Page unload:** Pending debounced writes may be lost (acceptable - at most 500ms of changes)
