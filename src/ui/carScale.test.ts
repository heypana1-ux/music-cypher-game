import { describe, expect, it } from 'vitest';
import { carScale } from './CarMode';

describe('car mode scaling', () => {
  it('stays 1:1 on a normal phone layout', () => {
    expect(carScale(412, 860).zoom).toBe(1);
    expect(carScale(390, 780).zoom).toBe(1);
  });
  it('scales up in Chrome "Desktop-Website" mode so it looks like the phone layout', () => {
    const s = carScale(980, 1990);
    expect(s.zoom).toBeCloseTo(Math.min(980 / 412, 1990 / 860), 6);
    expect(s.width * s.zoom).toBeCloseTo(980, 6);
    expect(s.height * s.zoom).toBeCloseTo(1990, 6);
  });
  it('limited by height on wide screens', () => {
    expect(carScale(1920, 1000).zoom).toBeCloseTo(1000 / 860, 2);
  });
});
