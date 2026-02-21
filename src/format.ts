export function formatTimeSaved(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hr = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return pad(hr) + ':' + pad(min) + ':' + pad(sec);
}

export function updateSliderFillPercent(
  value: number,
  min: number,
  max: number,
): number {
  return ((value - min) / (max - min)) * 100;
}
