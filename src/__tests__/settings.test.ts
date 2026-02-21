import { describe, it, expect } from 'vitest';
import { mergeSettings, DEFAULT_SETTINGS } from '../settings';

describe('mergeSettings', () => {
  it('should return default settings when stored is undefined', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('should return default settings when stored is empty object', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('should override individual settings', () => {
    const result = mergeSettings({ silenceThreshold: -30 });
    expect(result.silenceThreshold).toBe(-30);
    expect(result.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(result.minSilenceDuration).toBe(DEFAULT_SETTINGS.minSilenceDuration);
  });

  it('should override multiple settings', () => {
    const result = mergeSettings({
      enabled: false,
      actionMode: 'speed',
      speedMultiplier: 8,
    });
    expect(result.enabled).toBe(false);
    expect(result.actionMode).toBe('speed');
    expect(result.speedMultiplier).toBe(8);
  });

  it('should preserve all default fields when partially overriding', () => {
    const result = mergeSettings({ musicEnabled: true });
    const keys = Object.keys(DEFAULT_SETTINGS);
    for (const key of keys) {
      expect(result).toHaveProperty(key);
    }
    expect(result.musicEnabled).toBe(true);
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('should have expected default values', () => {
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.silenceEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.silenceThreshold).toBe(-40);
    expect(DEFAULT_SETTINGS.minSilenceDuration).toBe(0.5);
    expect(DEFAULT_SETTINGS.musicEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.musicSensitivity).toBe(0.5);
    expect(DEFAULT_SETTINGS.minMusicDuration).toBe(1.0);
    expect(DEFAULT_SETTINGS.actionMode).toBe('skip');
    expect(DEFAULT_SETTINGS.speedMultiplier).toBe(4);
  });
});
