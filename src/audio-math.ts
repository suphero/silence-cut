import type { SpectralFeatures } from './types';

export const DEFAULT_SPECTRUM: SpectralFeatures = {
  spectralFlatness: 0,
  speechBandRatio: 1,
  spectralCentroid: 0,
  spectralSpread: 0,
  spectralRolloff: 0,
  spectralFlux: 0,
};

export function computeTimeDomain(buffer: Float32Array): {
  volumeDB: number;
  zcr: number;
} {
  let sumSquares = 0;
  let crossings = 0;

  for (let i = 0; i < buffer.length; i++) {
    sumSquares += buffer[i] * buffer[i];
    if (i > 0 && buffer[i] >= 0 !== buffer[i - 1] >= 0) {
      crossings++;
    }
  }

  const rms = Math.sqrt(sumSquares / buffer.length);
  const volumeDB = rms === 0 ? -Infinity : 20 * Math.log10(rms);
  const zcr = buffer.length > 1 ? crossings / (buffer.length - 1) : 0;

  return { volumeDB, zcr };
}

export function compensateVolume(
  volumeDB: number,
  elementVolume: number,
): number {
  if (elementVolume > 0 && elementVolume < 1) {
    return volumeDB - 20 * Math.log10(elementVolume);
  }
  return volumeDB;
}

export function computeSpectrum(
  freqData: Uint8Array,
  sampleRate: number,
  fftSize: number,
  previousFreqData: Uint8Array | null,
): SpectralFeatures {
  const freqBins = freqData.length;
  const binHz = sampleRate / fftSize;

  const startBin = Math.max(1, Math.floor(20 / binHz));
  const endBin = Math.min(freqBins, Math.floor(16000 / binHz));

  const speechStart = Math.floor(300 / binHz);
  const speechEnd = Math.floor(3000 / binHz);

  let sumLog = 0;
  let sumLinear = 0;
  let count = 0;
  let speechEnergy = 0;
  let totalEnergy = 0;
  let weightedFreqSum = 0;
  let magnitudeSum = 0;
  let rawEnergyTotal = 0;

  for (let i = startBin; i < endBin; i++) {
    const raw = freqData[i];
    const val = raw + 1;

    sumLog += Math.log(val);
    sumLinear += val;
    count++;

    const energy = val * val;
    totalEnergy += energy;
    if (i >= speechStart && i < speechEnd) {
      speechEnergy += energy;
    }

    const freq = i * binHz;
    weightedFreqSum += raw * freq;
    magnitudeSum += raw;
    rawEnergyTotal += raw * raw;
  }

  if (count === 0 || sumLinear === 0) return DEFAULT_SPECTRUM;

  const geometricMean = Math.exp(sumLog / count);
  const arithmeticMean = sumLinear / count;
  const spectralFlatness = geometricMean / arithmeticMean;
  const speechBandRatio = totalEnergy > 0 ? speechEnergy / totalEnergy : 1;
  const spectralCentroid =
    magnitudeSum > 0 ? weightedFreqSum / magnitudeSum : 0;

  let spreadSum = 0;
  let cumEnergy = 0;
  let rolloffFreq = endBin * binHz;
  let rolloffFound = false;
  let fluxSum = 0;
  const rolloffTarget = rawEnergyTotal > 0 ? rawEnergyTotal * 0.85 : Infinity;

  for (let i = startBin; i < endBin; i++) {
    const raw = freqData[i];
    const freq = i * binHz;

    const d = freq - spectralCentroid;
    spreadSum += raw * d * d;

    if (!rolloffFound) {
      cumEnergy += raw * raw;
      if (cumEnergy >= rolloffTarget) {
        rolloffFreq = freq;
        rolloffFound = true;
      }
    }

    if (previousFreqData) {
      const fd = raw - previousFreqData[i];
      fluxSum += fd * fd;
    }
  }

  const spectralSpread =
    magnitudeSum > 0 ? Math.sqrt(spreadSum / magnitudeSum) : 0;
  const spectralFlux = previousFreqData
    ? Math.sqrt(fluxSum / (endBin - startBin))
    : 0;

  return {
    spectralFlatness,
    speechBandRatio,
    spectralCentroid,
    spectralSpread,
    spectralRolloff: rolloffFreq,
    spectralFlux,
  };
}

export function computeSkipIntensity(
  volumeDB: number,
  silenceThreshold: number,
  rampDB: number,
): number {
  const dist = silenceThreshold - volumeDB;
  const linear = Math.min(1, Math.max(0, dist / rampDB));
  return linear * linear;
}

export function computeZcrVariance(zcrBuffer: number[]): number {
  if (zcrBuffer.length < 4) return 0;
  const mean = zcrBuffer.reduce((a, b) => a + b, 0) / zcrBuffer.length;
  return (
    zcrBuffer.reduce((sum, v) => sum + (v - mean) ** 2, 0) / zcrBuffer.length
  );
}
