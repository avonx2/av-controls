import type * as Timeline from './engine';

export type StoredAudioTrack = {
  assetHash: string;
  fileName: string;
  markers: number[];
  snapEnabled: boolean;
  expanded: boolean;
};

export type StoredProject = {
  key: string;
  artworkId: string;
  name: string;
  state: Timeline.TimelineState;
  updatedAt: number;
  audioTrack?: StoredAudioTrack;
  uiState?: {
    expandedRows: Record<string, { expansion?: 'collapsed' | 'expanded' | 'pinned' | 'all'; expanded?: boolean; height: number; pinned?: boolean }>;
    labelWidth: number;
    scrollTop: number;
    secondsPerWidth: number;
    timeOffset: number;
    playheadTime?: number;
    loopFromSec?: number;
    liveEnabled?: boolean;
  };
};

export type StoredAudioAsset = {
  hash: string;
  fileName: string;
  mimeType: string;
  size: number;
  duration: number;
  blob: Blob;
  createdAt: number;
};

export type StoredWaveform = {
  hash: string;
  duration: number;
  sampleRate: number;
  baseBinSamples: number;
  levels: Array<{
    binSamples: number;
    values: number[];
  }>;
  createdAt: number;
};

const DB_NAME = 'avonx-timeline';
const PROJECT_STORE = 'projects';
const AUDIO_ASSET_STORE = 'audio-assets';
const WAVEFORM_STORE = 'waveforms';

let dbPromise: Promise<IDBDatabase> | null = null;

function toPlainData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function sanitizeTimelineStateForPersistence(state: Timeline.TimelineState): Timeline.TimelineState {
  return {
    ...toPlainData(state),
    controls: state.controls.map(control => ({
      ...toPlainData(control),
      enabled: true,
      manualOverride: false,
    })),
  };
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        const store = db.createObjectStore(PROJECT_STORE, { keyPath: 'key' });
        store.createIndex('byArtwork', 'artworkId', { unique: false });
      }
      if (!db.objectStoreNames.contains(AUDIO_ASSET_STORE)) {
        db.createObjectStore(AUDIO_ASSET_STORE, { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains(WAVEFORM_STORE)) {
        db.createObjectStore(WAVEFORM_STORE, { keyPath: 'hash' });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

export async function saveProject(project: StoredProject): Promise<void> {
  const db = await openDb();
  const plainProject = toPlainData(project);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(PROJECT_STORE).put(plainProject);
  });
}

export async function loadProject(key: string): Promise<StoredProject | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, 'readonly');
    tx.onerror = () => reject(tx.error);
    const request = tx.objectStore(PROJECT_STORE).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function listProjects(artworkId: string): Promise<StoredProject[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, 'readonly');
    const store = tx.objectStore(PROJECT_STORE);
    const index = store.index('byArtwork');
    const request = index.getAll(artworkId);
    request.onsuccess = () => resolve((request.result ?? []).sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
  });
}

export async function deleteProject(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(PROJECT_STORE).delete(key);
  });
}

export async function saveAudioAsset(asset: StoredAudioAsset): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(AUDIO_ASSET_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(AUDIO_ASSET_STORE).put(asset);
  });
}

export async function loadAudioAsset(hash: string): Promise<StoredAudioAsset | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_ASSET_STORE, 'readonly');
    tx.onerror = () => reject(tx.error);
    const request = tx.objectStore(AUDIO_ASSET_STORE).get(hash);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveWaveform(waveform: StoredWaveform): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(WAVEFORM_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(WAVEFORM_STORE).put(toPlainData(waveform));
  });
}

export async function loadWaveform(hash: string): Promise<StoredWaveform | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WAVEFORM_STORE, 'readonly');
    tx.onerror = () => reject(tx.error);
    const request = tx.objectStore(WAVEFORM_STORE).get(hash);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}
