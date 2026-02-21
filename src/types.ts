// --- Settings ---

export type ActionMode = 'skip' | 'speed';

export interface Settings {
  enabled: boolean;
  silenceEnabled: boolean;
  silenceThreshold: number;
  minSilenceDuration: number;
  musicEnabled: boolean;
  musicSensitivity: number;
  minMusicDuration: number;
  actionMode: ActionMode;
  speedMultiplier: number;
}

// --- Audio Features ---

export interface SpectralFeatures {
  spectralFlatness: number;
  speechBandRatio: number;
  spectralCentroid: number;
  spectralSpread: number;
  spectralRolloff: number;
  spectralFlux: number;
}

export interface DebugFeatures {
  zcr: number;
  zcrVariance: number;
  spectralFlatness: number;
  speechBandRatio: number;
  spectralCentroid: number;
  spectralSpread: number;
  spectralRolloff: number;
  spectralFlux: number;
}

// --- Status ---

export type SkipReason = 'silence' | 'music' | null;

export interface Status {
  active: boolean;
  skippedCount: number;
  timeSavedMs: number;
  currentVolumeDB: number;
  isInSilence: boolean;
  skipReason: SkipReason;
  isMusic: boolean;
  isAtLiveEdge: boolean;
}

// --- Messages (window.postMessage between MAIN world and content script) ---

export interface VolumeUpdateMessage {
  type: 'SILENCE_CUT_VOLUME_UPDATE';
  volumeDB: number;
  isInSilence: boolean;
  skipReason: SkipReason;
  skippedCount: number;
  timeSavedMs: number;
  isMusic: boolean;
  isAtLiveEdge: boolean;
  features: DebugFeatures | null;
}

export interface AnalyzerReadyMessage {
  type: 'SILENCE_CUT_ANALYZER_READY';
}

export interface InitMessage {
  type: 'SILENCE_CUT_INIT';
  settings: Settings;
}

export interface UpdateSettingsMessage {
  type: 'SILENCE_CUT_UPDATE_SETTINGS';
  settings: Settings;
}

export interface TeardownMessage {
  type: 'SILENCE_CUT_TEARDOWN';
}

export type AnalyzerMessage =
  | VolumeUpdateMessage
  | AnalyzerReadyMessage
  | InitMessage
  | UpdateSettingsMessage
  | TeardownMessage;

// --- Chrome runtime messages ---

export interface GetStatusMessage {
  type: 'GET_STATUS';
}

export interface SettingsChangedMessage {
  type: 'SETTINGS_CHANGED';
  settings: Settings;
}

export interface ToggleEnabledMessage {
  type: 'TOGGLE_ENABLED';
  enabled: boolean;
}

export interface GetSettingsMessage {
  type: 'GET_SETTINGS';
}

export interface UpdateBadgeMessage {
  type: 'UPDATE_BADGE';
  enabled: boolean;
  tabId?: number;
}

export type RuntimeMessage =
  | GetStatusMessage
  | SettingsChangedMessage
  | ToggleEnabledMessage
  | GetSettingsMessage
  | UpdateBadgeMessage;

// --- Audio node cache ---

export interface AudioNodeCacheEntry {
  audioContext: AudioContext;
  sourceNode: MediaElementAudioSourceNode;
}
