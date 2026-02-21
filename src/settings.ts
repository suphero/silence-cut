import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  silenceEnabled: true,
  silenceThreshold: -40,
  minSilenceDuration: 0.5,
  musicEnabled: false,
  musicSensitivity: 0.5,
  minMusicDuration: 1.0,
  actionMode: 'skip',
  speedMultiplier: 4,
};

export function mergeSettings(
  stored: Partial<Settings> | undefined,
): Settings {
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}
