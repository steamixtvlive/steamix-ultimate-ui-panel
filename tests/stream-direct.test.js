import { describe, expect, it } from 'vitest';
import { wantsDirectUpstream } from '../src/controllers/streamControllerHelpers.js';

describe('direct kota parametresi', () => {
  it('direct=1 ve redirect=1 kabul eder', () => {
    expect(wantsDirectUpstream({ query: { direct: '1' } })).toBe(true);
    expect(wantsDirectUpstream({ query: { redirect: '1' } })).toBe(true);
    expect(wantsDirectUpstream({ query: { direct: 'true' } })).toBe(true);
  });

  it('yoksa veya bossa proxy modunda kalir', () => {
    expect(wantsDirectUpstream({ query: {} })).toBe(false);
    expect(wantsDirectUpstream({ query: { direct: '0' } })).toBe(false);
    expect(wantsDirectUpstream({})).toBe(false);
    expect(wantsDirectUpstream(null)).toBe(false);
  });
});
