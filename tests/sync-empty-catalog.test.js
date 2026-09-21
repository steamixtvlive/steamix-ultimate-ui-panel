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

import { createXtreamClient, fetchProviderCatalog } from '../src/services/providerCatalogSyncService.js';

const dead = { ok: false, status: 403 };

describe('fetchProviderCatalog bos donus ve hata sebebi', () => {
  beforeEach(() => {
    fetchSafeMock.mockReset();
    fetchSafeMock.mockResolvedValue(dead);
  });

  it('hicbir tur gelmezse errors alanlarini doldurur', async () => {
    const provider = { url: 'http://ornek.test:8080', username: 'u', password: 'p' };
    const res = await fetchProviderCatalog(provider, createXtreamClient(provider));
    expect(res.allChannels).toEqual([]);
    expect(res.errors.live).toContain('403');
    expect(res.errors.movie).toContain('403');
    expect(res.errors.series).toContain('403');
  });

  it('provider user_agent tum isteklere header olarak gider', async () => {
    const provider = { url: 'http://ornek.test:8080', username: 'u', password: 'p', user_agent: 'TestUA/1.0' };
    await fetchProviderCatalog(provider, createXtreamClient(provider));
    expect(fetchSafeMock).toHaveBeenCalled();
    for (const call of fetchSafeMock.mock.calls) {
      expect(call[1]?.headers?.['User-Agent']).toBe('TestUA/1.0');
    }
  });

  it('user_agent bossa header eklenmez', async () => {
    const provider = { url: 'http://ornek.test:8080', username: 'u', password: 'p' };
    await fetchProviderCatalog(provider, createXtreamClient(provider));
    for (const call of fetchSafeMock.mock.calls) {
      expect(call[1]?.headers?.['User-Agent']).toBeUndefined();
    }
  });
});
