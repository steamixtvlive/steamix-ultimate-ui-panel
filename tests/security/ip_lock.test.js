import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/db.js', () => ({
  default: { prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })) }
}));

import { resolveIpLock } from '../../src/services/geoIpService.js';

describe('IP lock karari (resolveIpLock)', () => {
  it('kilit yoksa serbest', () => {
    expect(resolveIpLock({ allowedIp: null, currentIp: '1.2.3.4', isWhitelisted: false, hasActiveSession: false })).toBe('allow');
    expect(resolveIpLock({ allowedIp: '', currentIp: '1.2.3.4', isWhitelisted: false, hasActiveSession: true })).toBe('allow');
  });

  it('whitelist her zaman serbest', () => {
    expect(resolveIpLock({ allowedIp: '1.1.1.1', currentIp: '2.2.2.2', isWhitelisted: true, hasActiveSession: true })).toBe('allow');
  });

  it('IP bilinmiyorsa fail-open', () => {
    expect(resolveIpLock({ allowedIp: '1.1.1.1', currentIp: null, isWhitelisted: false, hasActiveSession: false })).toBe('allow');
  });

  it('ayni IP serbest', () => {
    expect(resolveIpLock({ allowedIp: '1.2.3.4', currentIp: '1.2.3.4', isWhitelisted: false, hasActiveSession: true })).toBe('allow');
  });

  it('farkli IP + aktif oturum yoksa yeniden ogren (modem/VPN/mobil)', () => {
    expect(resolveIpLock({ allowedIp: '1.1.1.1', currentIp: '2.2.2.2', isWhitelisted: false, hasActiveSession: false })).toBe('relearn');
  });

  it('farkli IP + aktif oturum varsa reddet (paylasim)', () => {
    expect(resolveIpLock({ allowedIp: '1.1.1.1', currentIp: '2.2.2.2', isWhitelisted: false, hasActiveSession: true })).toBe('deny');
  });
});
