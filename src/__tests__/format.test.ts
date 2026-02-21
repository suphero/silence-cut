import { describe, it, expect } from 'vitest';
import { formatTimeSaved, updateSliderFillPercent } from '../format';

describe('formatTimeSaved', () => {
  it('should format 0ms as 00:00:00', () => {
    expect(formatTimeSaved(0)).toBe('00:00:00');
  });

  it('should format seconds correctly', () => {
    expect(formatTimeSaved(5000)).toBe('00:00:05');
    expect(formatTimeSaved(59000)).toBe('00:00:59');
  });

  it('should format minutes correctly', () => {
    expect(formatTimeSaved(60000)).toBe('00:01:00');
    expect(formatTimeSaved(90000)).toBe('00:01:30');
    expect(formatTimeSaved(3599000)).toBe('00:59:59');
  });

  it('should format hours correctly', () => {
    expect(formatTimeSaved(3600000)).toBe('01:00:00');
    expect(formatTimeSaved(7261000)).toBe('02:01:01');
  });

  it('should truncate sub-second milliseconds', () => {
    expect(formatTimeSaved(1500)).toBe('00:00:01');
    expect(formatTimeSaved(999)).toBe('00:00:00');
  });

  it('should pad single digits with leading zeros', () => {
    expect(formatTimeSaved(1000)).toBe('00:00:01');
    expect(formatTimeSaved(61000)).toBe('00:01:01');
    expect(formatTimeSaved(3661000)).toBe('01:01:01');
  });
});

describe('updateSliderFillPercent', () => {
  it('should return 0% at minimum value', () => {
    expect(updateSliderFillPercent(0, 0, 100)).toBe(0);
  });

  it('should return 100% at maximum value', () => {
    expect(updateSliderFillPercent(100, 0, 100)).toBe(100);
  });

  it('should return 50% at midpoint', () => {
    expect(updateSliderFillPercent(50, 0, 100)).toBe(50);
  });

  it('should handle negative ranges (dB sliders)', () => {
    // Slider from -60 to -10, value at -40
    const pct = updateSliderFillPercent(-40, -60, -10);
    expect(pct).toBeCloseTo(40);
  });

  it('should handle decimal ranges', () => {
    const pct = updateSliderFillPercent(0.3, 0.1, 0.9);
    expect(pct).toBeCloseTo(25);
  });
});
