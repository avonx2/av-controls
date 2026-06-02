import { Controls, InputSource, MidiSource as ProtocolMidiSource, KeyboardSource, InputSignal } from '@av-controls/protocol'
import { Errors } from '@av-controls/protocol';
const { Logger } = Errors;

// Import WebMidi and its types
import { WebMidi, Input } from 'webmidi';

// Re-export source and signal types from protocol
export type { InputSource, KeyboardSource } from '@av-controls/protocol'
export { MidiSource as ProtocolMidiSource, InputSignal } from '@av-controls/protocol'

// Legacy MIDI source interface for backward compatibility
export interface MidiSource {
  id: string,
  type: 'key' | 'cc'
}

/**
 * Base class for all input mappings
 */
export abstract class InputMapping {
  public abstract source: InputSource
  public abstract sender: Controls.Base.Sender
  abstract handleInputSignal(signal: InputSignal): void
}

/**
 * Base interface for all MIDI signals (forward declaration)
 */
export interface MidiSignal {
  sourceId: string;
  type: string;
}

/**
 * MIDI-specific mapping base
 */
export abstract class MidiMapping extends InputMapping {
  public abstract source: ProtocolMidiSource
  abstract handleMidiSignal(signal: MidiSignal): void

  handleInputSignal(signal: InputSignal): void {
    // Forward to MIDI handler - type will be checked in concrete implementations
    this.handleMidiSignal(signal as any)
  }
}

export class CCToFaderMapping extends MidiMapping {
  constructor(
    public sender: Controls.Fader.Sender,
    public source: ProtocolMidiSource,
  ) {
    super()
  }
  handleMidiSignal(signal: MidiSignal) {
    // Will be instance of ControlChange at runtime
    if('cc' in signal && 'value' in signal) {
      this.sender.setNormValue((signal as any).value)
    }
  }
}

export class CCToKnobMapping extends MidiMapping {
  constructor(
    public sender: Controls.Knob.Sender,
    public source: ProtocolMidiSource,
  ) {
    super()
  }
  handleMidiSignal(signal: MidiSignal) {
    // Will be instance of ControlChange at runtime
    if('cc' in signal && 'value' in signal) {
      this.sender.setNormValue((signal as any).value)
    }
  }
}

export class MidiKeyToPadMapping extends MidiMapping {
  constructor(
    public sender: Controls.Pad.Sender,
    public source: ProtocolMidiSource,
  ) {
    super()
  }
  handleMidiSignal(signal: MidiSignal) {
    // Will be instance of NoteOn/NoteOff at runtime
    if('velocity' in signal) {
      // NoteOn
      this.sender.press((signal as any).velocity)
    } else if('key' in signal && signal.type === 'note-off') {
      // NoteOff
      this.sender.release()
    }
  }
}

export class MidiKeyToSwitchMapping extends MidiMapping {
  constructor(
    public sender: Controls.Switch.Sender,
    public source: ProtocolMidiSource,
  ) {
    super()
  }
  handleMidiSignal(signal: MidiSignal) {
    // Will be instance of NoteOn at runtime
    if('velocity' in signal) {
      this.sender.toggle()
    }
  }
}

/**
 * Keyboard-specific mapping base
 */
export abstract class KeyboardMapping extends InputMapping {
  public abstract source: KeyboardSource
  abstract handleKeyboardSignal(signal: KeyboardSignal): void

  handleInputSignal(signal: InputSignal): void {
    if (signal instanceof KeyboardSignal) {
      this.handleKeyboardSignal(signal)
    }
  }
}

export class KeyboardToPadMapping extends KeyboardMapping {
  constructor(
    public sender: Controls.Pad.Sender,
    public source: KeyboardSource,
  ) {
    super()
  }
  handleKeyboardSignal(signal: KeyboardSignal) {
    if(signal.pressed) {
      this.sender.press(0.8) // Fixed velocity for keyboard
    } else {
      this.sender.release()
    }
  }
}

export class KeyboardToSwitchMapping extends KeyboardMapping {
  constructor(
    public sender: Controls.Switch.Sender,
    public source: KeyboardSource,
  ) {
    super()
  }
  handleKeyboardSignal(signal: KeyboardSignal) {
    // Toggle only on press, ignore release
    if(signal.pressed) {
      this.sender.toggle()
    }
  }
}

/**
 * Interface for MIDI signals related to keys (notes)
 */
export interface KeyMidiSignal extends MidiSignal {
  channel: number;
  key: number;
}

/**
 * Note On MIDI signal
 */
export class NoteOn extends InputSignal implements KeyMidiSignal {
  public readonly type = 'note-on';

  constructor(
    public readonly channel: number,
    public readonly key: number,
    public readonly velocity: number
  ) {
    super(`key-${channel}-${key}`, 'midi-note-on')
  }
}

/**
 * Note Off MIDI signal
 */
export class NoteOff extends InputSignal implements KeyMidiSignal {
  public readonly type = 'note-off';

  constructor(
    public readonly channel: number,
    public readonly key: number
  ) {
    super(`key-${channel}-${key}`, 'midi-note-off')
  }
}

/**
 * Control Change MIDI signal (for knobs, sliders, etc.)
 */
export class ControlChange extends InputSignal implements MidiSignal {
  public readonly type = 'control-change';

  constructor(
    public readonly channel: number,
    public readonly cc: number,
    public readonly value: number
  ) {
    super(`cc-${channel}-${cc}`, 'midi-control-change')
  }
}

export class ProgramChange extends InputSignal implements MidiSignal {
  public readonly type = 'program-change';

  constructor(
    public readonly channel: number,
    public readonly program: number
  ) {
    super(`pgm-${channel}`, 'midi-program-change')
  }
}

/**
 * Keyboard signal
 */
export class KeyboardSignal extends InputSignal {
  public readonly type = 'keyboard';

  constructor(
    public readonly code: string,     // e.g., "KeyA", "Digit1"
    public readonly key: string,      // e.g., "a", "1"
    public readonly pressed: boolean  // true for keydown, false for keyup
  ) {
    super(`keyboard-${code}`, 'keyboard')
  }
}

/**
 * Type for input signal handlers
 */
export type InputListener = (signal: InputSignal) => void;

/**
 * Class for handling input mappings (MIDI + Keyboard)
 */
export class InputMappings {
  private mappingsBySource: {[sourceId: string]: InputMapping[]} = {}
  private mappingsBySender = new Map<Controls.Base.Sender, InputSource[]>() // Inverse index for O(1) lookups
  private mappingCountCallbacks = new Map<Controls.Base.Sender, ((count: number) => void)[]>() // One-shot callbacks
  private listeners: InputListener[] = [];
  private midiConnected = false;
  private keyboardConnected = false;
  private localStorageItemName: string;
  private keyboardListener?: (event: KeyboardEvent) => void;
  private pressedKeys = new Set<string>(); // Track which keys are currently pressed
  private midiConnectedListener?: (event: any) => void;
  private midiDisconnectedListener?: (event: any) => void;

  /**
   * Create a new input manager
   */
  constructor(
    private artworkName: string = 'default',
    private artworkVersion: string = '1.0.0',
    private rootSender: Controls.Base.Sender
  ) {
    this.localStorageItemName = `midi-mappings-${this.artworkName}` // Keep old name for now
  }

  /**
   * Get the number of mappings for a given sender (O(1) lookup)
   */
  getMappingCount(sender: Controls.Base.Sender): number {
    return this.mappingsBySender.get(sender)?.length ?? 0
  }

  /**
   * Get all input sources mapped to a sender (O(1) lookup)
   */
  getMappings(sender: Controls.Base.Sender): InputSource[] {
    return this.mappingsBySender.get(sender) ?? []
  }

  /**
   * Wait for the next mapping count change for a sender (one-shot callback pattern)
   * Returns the current count immediately, and fires the callback once on the next change.
   * After firing, the callback is discarded (caller must resubscribe).
   */
  waitForNextMappingCountChange(sender: Controls.Base.Sender, callback: (count: number) => void): number {
    // Get or create callbacks array for this sender
    let callbacks = this.mappingCountCallbacks.get(sender)
    if (!callbacks) {
      callbacks = []
      this.mappingCountCallbacks.set(sender, callbacks)
    }

    // Add callback to array
    callbacks.push(callback)

    // Return current count
    return this.getMappingCount(sender)
  }

  /**
   * Notify all callbacks for a sender about mapping count change (one-shot)
   */
  private notifyMappingCountChange(sender: Controls.Base.Sender) {
    const callbacks = this.mappingCountCallbacks.get(sender)
    if (callbacks && callbacks.length > 0) {
      // Clear callbacks first to prevent infinite loop if callback resubscribes
      this.mappingCountCallbacks.delete(sender)

      const count = this.getMappingCount(sender)
      // Fire all callbacks (they can safely resubscribe now)
      callbacks.forEach(cb => cb(count))
    }
  }

  /**
   * Check if Web MIDI API is supported in the current browser
   */
  static isMidiSupported(): boolean {
    return WebMidi.supported;
  }

  /**
   * Connect to MIDI devices
   */
  async connectMidi(
    onError?: (error: Error) => void,
  ): Promise<void> {
    if (!InputMappings.isMidiSupported()) {
      onError?.(new Error('MIDI not supported'))
      return;
    }
    if (this.midiConnected) {
      onError?.(new Error('MIDI already connected'))
      return;
    }

    try {
      await WebMidi.enable();

      // Add event listeners to all inputs
      WebMidi.inputs.forEach(input => {
        this.setupMidiInputListeners(input);
      });

      // Listen for device connection/disconnection
      this.midiConnectedListener = (event) => {
        if (event.port.type === 'input') {
          Logger.info('MIDI input connected', { port: event.port.name });
          this.setupMidiInputListeners(event.port as Input);
        }
      };
      WebMidi.addListener('connected', this.midiConnectedListener);

      this.midiDisconnectedListener = (event) => {
        Logger.info('MIDI device disconnected', {
          port: event.port.name,
          type: event.port.type
        });
      };
      WebMidi.addListener('disconnected', this.midiDisconnectedListener);

      this.midiConnected = true;

      console.log(`MIDI connected. Devices: ${this.getMidiInputDevices().map(d => d.name).join(', ')} inputs, ${this.getMidiOutputDevices().map(d => d.name).join(', ')} outputs`);

    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Connect keyboard input
   */
  connectKeyboard(): void {
    if (this.keyboardConnected) {
      return;
    }

    this.keyboardListener = (event: KeyboardEvent) => {
      // Ignore repeat events (holding key down)
      if (event.repeat) {
        return;
      }

      const signal = new KeyboardSignal(
        event.code,
        event.key,
        event.type === 'keydown'
      );

      console.log('Keyboard signal created:', signal.sourceId, signal.pressed);

      // Track key state
      if (signal.pressed) {
        this.pressedKeys.add(event.code);
      } else {
        this.pressedKeys.delete(event.code);
      }

      this.handleInputSignal(signal);
    };

    window.addEventListener('keydown', this.keyboardListener);
    window.addEventListener('keyup', this.keyboardListener);

    this.keyboardConnected = true;
    console.log('Keyboard input connected');
  }

  /**
   * Disconnect keyboard input
   */
  disconnectKeyboard(): void {
    if (this.keyboardListener) {
      window.removeEventListener('keydown', this.keyboardListener);
      window.removeEventListener('keyup', this.keyboardListener);
      this.keyboardListener = undefined;
      this.pressedKeys.clear();
      this.keyboardConnected = false;
      console.log('Keyboard input disconnected');
    }
  }

  /**
   * Connect all input sources
   */
  async connect(onError?: (error: Error) => void): Promise<void> {
    await this.connectMidi(onError);
    this.connectKeyboard();
  }

  disconnectMidi(): void {
    if (!this.midiConnected) {
      return;
    }

    if (this.midiConnectedListener) {
      WebMidi.removeListener('connected', this.midiConnectedListener);
      this.midiConnectedListener = undefined;
    }
    if (this.midiDisconnectedListener) {
      WebMidi.removeListener('disconnected', this.midiDisconnectedListener);
      this.midiDisconnectedListener = undefined;
    }

    WebMidi.inputs.forEach(input => {
      input.removeListener();
    });

    this.midiConnected = false;
  }

  /**
   * Setup listeners for a MIDI input device
   */
  private setupMidiInputListeners(input: Input): void {
    // Note on events
    input.addListener('noteon', event => {
      const signal = new NoteOn(
        event.message.channel,
        event.note.number,
        event.note.attack
      );
      this.handleInputSignal(signal);
    });

    // Note off events
    input.addListener('noteoff', event => {
      const signal = new NoteOff(
        event.message.channel,
        event.note.number
      );
      this.handleInputSignal(signal);
    });

    // Control change events
    input.addListener('controlchange', event => {
      if(typeof event.value === 'number') {
        const signal = new ControlChange(
          event.message.channel,
          event.controller.number,
          event.value
        );
        this.handleInputSignal(signal);
      }
    });

    // Program change events
    input.addListener('programchange', event => {
      if(typeof event.value !== 'number') {
        return
      }
      const signal = new ProgramChange(
        event.message.channel,
        event.value
      );
      this.handleInputSignal(signal);
    });
  }

  /**
   * Handle incoming input signals
   */
  private handleInputSignal(signal: InputSignal): void {
    // Notify all relevant mappings
    const mappings = this.mappingsBySource[signal.sourceId];
    if (mappings) {
      mappings.forEach(mapping => {
        mapping.handleInputSignal(signal);
      });
    }

    // Notify all listeners
    this.listeners.forEach(listener => {
      listener(signal);
    });
  }

  /**
   * Add a listener for input signals
   */
  addListener(listener: InputListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove a listener
   */
  removeListener(listener: InputListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Get a list of connected MIDI input devices
   */
  getMidiInputDevices(): Input[] {
    return WebMidi.inputs;
  }

  /**
   * Get a list of connected MIDI output devices
   */
  getMidiOutputDevices(): any[] {
    return WebMidi.outputs;
  }

  /**
   * Add mapping from input source to control
   */
  addMappingToControl(inputSource: InputSource, control: Controls.Base.Sender): boolean {
    let mapping: InputMapping | undefined

    // Handle MIDI sources
    if (inputSource instanceof ProtocolMidiSource) {
      if(inputSource.midiType === 'cc') {
        if(control instanceof Controls.Fader.Sender) {
          mapping = new CCToFaderMapping(control, inputSource)
        } else if (control instanceof Controls.Knob.Sender) {
          mapping = new CCToKnobMapping(control, inputSource)
        } else {
          console.warn('control change to non-fader/knob not implemented')
        }
      } else if(inputSource.midiType === 'key') {
        if(control instanceof Controls.Pad.Sender) {
          mapping = new MidiKeyToPadMapping(control, inputSource)
        } else if (control instanceof Controls.Switch.Sender) {
          mapping = new MidiKeyToSwitchMapping(control, inputSource)
        } else {
          console.warn('MIDI note to non-pad/switch not implemented')
        }
      }
    }
    // Handle Keyboard sources
    else if (inputSource instanceof KeyboardSource) {
      if(control instanceof Controls.Pad.Sender) {
        mapping = new KeyboardToPadMapping(control, inputSource)
      } else if (control instanceof Controls.Switch.Sender) {
        mapping = new KeyboardToSwitchMapping(control, inputSource)
      } else {
        console.warn('keyboard to non-pad/switch not implemented')
      }
    }
    // Handle legacy format (for backward compatibility)
    else if ('type' in inputSource && ('midiType' in inputSource || typeof (inputSource as any).type === 'string')) {
      const legacySource = inputSource as any
      const protocolSource = new ProtocolMidiSource(legacySource.id, legacySource.type)
      return this.addMappingToControl(protocolSource, control)
    }

    if(mapping) {
      // Add to mappingsBySource for signal routing
      const existingMappings = this.mappingsBySource[inputSource.id]
      if(existingMappings === undefined) {
        this.mappingsBySource[inputSource.id] = [mapping]
      } else {
        existingMappings.push(mapping)
      }

      // Add to mappingsBySender inverse index for O(1) UI lookups
      if(!this.mappingsBySender.has(control)) {
        this.mappingsBySender.set(control, [])
      }
      this.mappingsBySender.get(control)!.push(inputSource)

      // Notify callbacks about the change
      this.notifyMappingCountChange(control)

      return true
    }
    return false
  }

  /**
   * Remove all mappings from a control
   */
  removeMappingsFromControl(sender: Controls.Base.Sender) {
    // Get the sources mapped to this sender
    const sources = this.mappingsBySender.get(sender)
    if(!sources) return

    // Remove from mappingsBySource
    sources.forEach(source => {
      const signalMappings = this.mappingsBySource[source.id]
      if(signalMappings) {
        this.mappingsBySource[source.id] = signalMappings.filter(m => m.sender !== sender)
      }
    })

    // Remove from inverse index
    this.mappingsBySender.delete(sender)

    // Notify callbacks about the change
    this.notifyMappingCountChange(sender)
  }

  /**
   * Save mappings to localStorage (will be migrated to IndexedDB later)
   */
  async saveMappings(mappingName: string, askForConfirmation: (name: string) => Promise<boolean>) {
    const mappingsString = localStorage.getItem(this.localStorageItemName)
    let mappings: {[id: string]: any} = {}
    if(mappingsString) {
      try {
        mappings = JSON.parse(mappingsString)
        if(mappings.hasOwnProperty(mappingName)) {
          if(!await askForConfirmation(mappingName)) {
            return
          }
        }
      } catch(e) {
        Logger.error(`Can't parse mappings from ${this.localStorageItemName}`, { error: e })
      }
    }
    mappings[mappingName] = this.recursivelyGatherMappings()
    localStorage.setItem(this.localStorageItemName, JSON.stringify(mappings))
  }

  deleteMapping(mappingName: string) {
    const mappingsString = localStorage.getItem(this.localStorageItemName)
    if(mappingsString) {
      try {
        const mappings = JSON.parse(mappingsString)
        if(mappings.hasOwnProperty(mappingName)) {
          delete mappings[mappingName]
          localStorage.setItem(this.localStorageItemName, JSON.stringify(mappings))
        }
      } catch(e) {
        Logger.error(`Can't parse mappings from ${this.localStorageItemName}`, { error: e })
      }
    }
  }

  exportMappingsAsFile() {
    console.log('exportMappingsAsFile')
    const mappings = this.recursivelyGatherMappings()
    // export as download file
    const blob = new Blob([JSON.stringify(mappings)], {type: 'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'mappings.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  loadMappings(name: string) {
    const savedMappings = localStorage.getItem(this.localStorageItemName)
    if(savedMappings) {
      const mappings = JSON.parse(savedMappings)
      if(mappings.hasOwnProperty(name)) {
        this.removeAllMappings()
        console.log('loadMappings', mappings)
        this.recursivelyAddMappings(mappings[name])
      }
    }
  }

  importMappingsFromFile(file: File) {
    const reader = new FileReader()
    reader.onload = (event) => {
      const mappings = JSON.parse(event.target!.result as string)
      this.removeAllMappings()
      this.recursivelyAddMappings(mappings)
    }
    reader.readAsText(file)
  }

  /**
   * Recursively gather all mappings from the control tree
   */
  recursivelyGatherMappings(): any {
    const mappings: any = {}
    this.rootSender.traverse((sender, object) => {
      // Use inverse index to get sources for this sender
      const sources = this.mappingsBySender.get(sender) ?? []
      object.mappings = sources.map(source => {
        // Serialize source based on type
        if (source instanceof ProtocolMidiSource) {
          return {
            type: 'midi',
            id: source.id,
            midiType: source.midiType
          }
        } else if (source instanceof KeyboardSource) {
          return {
            type: 'keyboard',
            code: source.code,
            key: source.key
          }
        }
        return null
      }).filter(s => s !== null)
    }, mappings)
    return mappings
  }

  /**
   * Recursively add mappings to the control tree
   */
  recursivelyAddMappings(mappings: any) {
    this.rootSender.traverse((sender, object) => {
      if(object.mappings) {
        object.mappings.forEach((sourceData: any) => {
          let source: InputSource | undefined

          // Deserialize source based on type
          if (sourceData.type === 'midi') {
            source = new ProtocolMidiSource(sourceData.id, sourceData.midiType)
          } else if (sourceData.type === 'keyboard') {
            source = new KeyboardSource(sourceData.code, sourceData.key)
          }
          // Handle legacy format
          else if (sourceData.type === 'key' || sourceData.type === 'cc') {
            source = new ProtocolMidiSource(sourceData.id, sourceData.type)
          }

          if (source) {
            this.addMappingToControl(source, sender)
          }
        })
      }
    }, mappings)
  }

  removeAllMappings() {
    // Get all senders before clearing
    const affectedSenders = Array.from(this.mappingsBySender.keys())

    // Clear both indexes
    this.mappingsBySource = {}
    this.mappingsBySender.clear()

    // Notify all affected senders
    affectedSenders.forEach(sender => this.notifyMappingCountChange(sender))
  }

  getSavedMappingsNames() {
    const mappingsString = localStorage.getItem(this.localStorageItemName)
    if(mappingsString) {
      try {
        const mappings = JSON.parse(mappingsString)
        return Object.keys(mappings)
      } catch(e) {
        Logger.error(`Can't parse mappings from ${this.localStorageItemName}`, { error: e })
      }
    }
    return []
  }

  dispose(): void {
    this.disconnectKeyboard()
    this.disconnectMidi()
    this.listeners = []
    this.mappingCountCallbacks.clear()
    this.removeAllMappings()
  }
}

// Export legacy class name for backward compatibility
export const MidiMappings = InputMappings;
