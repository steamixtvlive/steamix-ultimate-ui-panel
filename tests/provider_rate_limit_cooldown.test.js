import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSafeMock = vi.fn();

vi.mock('../src/utils/network.js', () => ({
  fetchSafe: (...args) => fetchSafeMock(...args)
}));

vi.mock('@iptv/xtream-api', () => ({
  Xtream: class {
    async getChannels() {
      throw new Error('api down');
    }
  }
}));

import {
  clearProviderRateLimits,
  createXtreamClient,
  fetchProviderCatalog,
  isProviderRateLimited,
} from '../src/services/providerCatalogSyncService.js';

const tooMany = { ok: false, status: 429, headers: { get: () => null } };

describe('provider 429 soguma', () => {
  beforeEach(() => {
    fetchSafeMock.mockReset();
    clearProviderRateLimits();
  });

  it('429 gorunce sogumaya alir ve sonraki cagri upstreame dokunmaz', async () => {
    const provider = { id: 7, url: 'http://ornek.test:8080', username: 'u', password: 'p' };
    fetchSafeMock.mockResolvedValue(tooMany);

    const first = await fetchProviderCatalog(provider, createXtreamClient(provider));
    expect(first.errors.live).toContain('429');
    expect(isProviderRateLimited(provider)).toBe(true);

    const callsAfterFirst = fetchSafeMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await fetchProviderCatalog(provider, createXtreamClient(provider));
    expect(second.errors.live).toContain('soguma');
    // Upstream'e yeni istek yok: hizli-basarisiz dondu.
    expect(fetchSafeMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('429 degilse (403) soguma olmaz, her cagri upstreame gider', async () => {
    const provider = { id: 8, url: 'http://ornek2.test:8080', username: 'u', password: 'p' };
    fetchSafeMock.mockResolvedValue({ ok: false, status: 403, headers: { get: () => null } });

    await fetchProviderCatalog(provider, createXtreamClient(provider));
    expect(isProviderRateLimited(provider)).toBe(false);
    const n = fetchSafeMock.mock.calls.length;
    await fetchProviderCatalog(provider, createXtreamClient(provider));
    expect(fetchSafeMock.mock.calls.length).toBeGreaterThan(n);
  });
});
