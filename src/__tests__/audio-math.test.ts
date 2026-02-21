import { describe, it, expect } from 'vitest';
import {
  computeTimeDomain,
  compensateVolume,
  computeSpectrum,
  computeSkipIntensity,
  computeZcrVariance,
  DEFAULT_SPECTRUM,
} from '../audio-math';

// --- computeTimeDomain ---

describe('computeTimeDomain', () => {
  it('should return -Infinity dB for a silent buffer', () => {
    const buffer = new Float32Array(1024); // all zeros
    const { volumeDB, zcr } = computeTimeDomain(buffer);
    expect(volumeDB).toBe(-Infinity);
    expect(zcr).toBe(0);
  });

  it('should compute 0 dB for a full-scale signal (RMS=1)', () => {
    // A buffer filled with 1.0 has RMS=1.0, so volumeDB = 20*log10(1) = 0
    const buffer = new Float32Array(1024).fill(1.0);
    const { volumeDB } = computeTimeDomain(buffer);
    expect(volumeDB).toBeCloseTo(0, 1);
  });

  it('should compute correct dB for known RMS', () => {
    // RMS = 0.1 -> 20*log10(0.1) = -20 dB
    const buffer = new Float32Array(1024).fill(0.1);
    const { volumeDB } = computeTimeDomain(buffer);
    expect(volumeDB).toBeCloseTo(-20, 1);
  });

  it('should compute ZCR for alternating signal', () => {
    // Signal alternates between +1 and -1 -> max zero crossings
    const size = 100;
    const buffer = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      buffer[i] = i % 2 === 0 ? 1 : -1;
    }
    const { zcr } = computeTimeDomain(buffer);
    // Every sample crosses zero: (size-1) crossings / (size-1) = 1.0
    expect(zcr).toBeCloseTo(1.0, 2);
  });

  it('should compute ZCR = 0 for constant positive signal', () => {
    const buffer = new Float32Array(100).fill(0.5);
    const { zcr } = computeTimeDomain(buffer);
    expect(zcr).toBe(0);
  });

  it('should compute ZCR for a sine wave', () => {
    // 1 cycle of sine in 100 samples: 2 zero crossings
    const size = 100;
    const buffer = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      buffer[i] = Math.sin((2 * Math.PI * i) / size);
    }
    const { zcr } = computeTimeDomain(buffer);
    // Expect ~2 crossings out of 99 possible = ~0.02
    expect(zcr).toBeGreaterThan(0.01);
    expect(zcr).toBeLessThan(0.05);
  });

  it('should handle single-sample buffer', () => {
    const buffer = new Float32Array([0.5]);
    const { zcr } = computeTimeDomain(buffer);
    expect(zcr).toBe(0);
  });
});

// --- compensateVolume ---

describe('compensateVolume', () => {
  it('should not change volume when element volume is 1', () => {
    expect(compensateVolume(-20, 1)).toBe(-20);
  });

  it('should not change volume when element volume is 0', () => {
    // volume=0 should not compensate (guard condition: volume > 0)
    expect(compensateVolume(-20, 0)).toBe(-20);
  });

  it('should compensate for half volume', () => {
    // volume=0.5 -> compensation = -20*log10(0.5) ≈ 6.02 dB
    const result = compensateVolume(-20, 0.5);
    expect(result).toBeCloseTo(-20 + 6.02, 1);
  });

  it('should compensate for quarter volume', () => {
    // volume=0.25 -> compensation = -20*log10(0.25) ≈ 12.04 dB
    const result = compensateVolume(-30, 0.25);
    expect(result).toBeCloseTo(-30 + 12.04, 1);
  });
});

// --- computeSpectrum ---

describe('computeSpectrum', () => {
  it('should return high flatness for all-zero frequency data (uniform +1 offset)', () => {
    // All bins are 0, but the algorithm adds +1 to each value,
    // making all vals equal (1), so flatness = geometric/arithmetic = 1
    const freqData = new Uint8Array(1024);
    const result = computeSpectrum(freqData, 44100, 2048, null);
    expect(result.spectralFlatness).toBeCloseTo(1, 2);
    // Centroid = 0 because all raw values are 0 (magnitudeSum = 0)
    expect(result.spectralCentroid).toBe(0);
  });

  it('should compute valid spectral features for uniform frequency data', () => {
    // Uniform data: all bins have same value -> high flatness
    const freqData = new Uint8Array(1024).fill(128);
    const result = computeSpectrum(freqData, 44100, 2048, null);

    expect(result.spectralFlatness).toBeGreaterThan(0);
    expect(result.spectralFlatness).toBeLessThanOrEqual(1);
    expect(result.speechBandRatio).toBeGreaterThan(0);
    expect(result.speechBandRatio).toBeLessThanOrEqual(1);
    expect(result.spectralCentroid).toBeGreaterThan(0);
    expect(result.spectralSpread).toBeGreaterThan(0);
    expect(result.spectralRolloff).toBeGreaterThan(0);
    // No previous data -> flux should be 0
    expect(result.spectralFlux).toBe(0);
  });

  it('should have high flatness for uniform signal', () => {
    const freqData = new Uint8Array(1024).fill(100);
    const result = computeSpectrum(freqData, 44100, 2048, null);
    // Uniform signal: geometric mean ≈ arithmetic mean -> flatness ≈ 1
    expect(result.spectralFlatness).toBeGreaterThan(0.95);
  });

  it('should have lower flatness for spike signal than uniform', () => {
    // One bin at 255, rest at 0. Due to +1 offset, the spike is 256 vs 1 for others.
    // Flatness drops compared to uniform but not extremely low due to +1 offset.
    const freqData = new Uint8Array(1024);
    freqData[100] = 255;
    const result = computeSpectrum(freqData, 44100, 2048, null);
    expect(result.spectralFlatness).toBeLessThan(0.95);

    // Compare to uniform where flatness ≈ 1
    const uniformData = new Uint8Array(1024).fill(100);
    const uniformResult = computeSpectrum(uniformData, 44100, 2048, null);
    expect(result.spectralFlatness).toBeLessThan(uniformResult.spectralFlatness);
  });

  it('should compute spectral flux when previous data is provided', () => {
    const freqData1 = new Uint8Array(1024).fill(50);
    const freqData2 = new Uint8Array(1024).fill(200);
    const result = computeSpectrum(freqData2, 44100, 2048, freqData1);
    expect(result.spectralFlux).toBeGreaterThan(0);
  });

  it('should compute zero flux when data is unchanged', () => {
    const freqData = new Uint8Array(1024).fill(100);
    const prevData = new Uint8Array(1024).fill(100);
    const result = computeSpectrum(freqData, 44100, 2048, prevData);
    expect(result.spectralFlux).toBe(0);
  });

  it('should have high speech band ratio for speech-frequency energy', () => {
    // Put energy only in speech band (300-3000 Hz)
    const freqData = new Uint8Array(1024);
    const binHz = 44100 / 2048;
    const speechStart = Math.floor(300 / binHz);
    const speechEnd = Math.floor(3000 / binHz);
    for (let i = speechStart; i < speechEnd; i++) {
      freqData[i] = 200;
    }
    const result = computeSpectrum(freqData, 44100, 2048, null);
    expect(result.speechBandRatio).toBeGreaterThan(0.8);
  });
});

// --- computeSkipIntensity ---

describe('computeSkipIntensity', () => {
  it('should return 0 when volume is above threshold', () => {
    // Volume -30 dB, threshold -40 dB -> dist = -40 - (-30) = -10 < 0
    expect(computeSkipIntensity(-30, -40, 8)).toBe(0);
  });

  it('should return 0 when volume equals threshold', () => {
    expect(computeSkipIntensity(-40, -40, 8)).toBe(0);
  });

  it('should return 1 when volume is far below threshold', () => {
    // Volume -60 dB, threshold -40 dB, ramp 8 dB
    // dist = -40 - (-60) = 20, linear = min(1, 20/8) = 1
    expect(computeSkipIntensity(-60, -40, 8)).toBe(1);
  });

  it('should return quadratic interpolation for mid-range', () => {
    // Volume -44 dB, threshold -40 dB, ramp 8 dB
    // dist = 4, linear = 4/8 = 0.5, intensity = 0.25
    expect(computeSkipIntensity(-44, -40, 8)).toBeCloseTo(0.25, 4);
  });

  it('should clamp to 1 at maximum distance', () => {
    // dist = exactly rampDB
    expect(computeSkipIntensity(-48, -40, 8)).toBe(1);
  });

  it('should scale quadratically', () => {
    // dist = 2, ramp = 8 -> linear = 0.25, intensity = 0.0625
    expect(computeSkipIntensity(-42, -40, 8)).toBeCloseTo(0.0625, 4);
  });
});

// --- computeZcrVariance ---

describe('computeZcrVariance', () => {
  it('should return 0 for fewer than 4 samples', () => {
    expect(computeZcrVariance([])).toBe(0);
    expect(computeZcrVariance([0.1])).toBe(0);
    expect(computeZcrVariance([0.1, 0.2])).toBe(0);
    expect(computeZcrVariance([0.1, 0.2, 0.3])).toBe(0);
  });

  it('should return 0 for constant values', () => {
    expect(computeZcrVariance([0.5, 0.5, 0.5, 0.5])).toBe(0);
  });

  it('should return positive variance for varying values', () => {
    const result = computeZcrVariance([0.1, 0.5, 0.2, 0.8]);
    expect(result).toBeGreaterThan(0);
  });

  it('should compute correct variance', () => {
    // Values: [1, 2, 3, 4], mean = 2.5
    // Variance = ((1-2.5)^2 + (2-2.5)^2 + (3-2.5)^2 + (4-2.5)^2) / 4
    //          = (2.25 + 0.25 + 0.25 + 2.25) / 4 = 1.25
    expect(computeZcrVariance([1, 2, 3, 4])).toBeCloseTo(1.25, 6);
  });

  it('should handle more than 4 samples', () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const expectedVariance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    expect(computeZcrVariance(values)).toBeCloseTo(expectedVariance, 6);
  });
});
