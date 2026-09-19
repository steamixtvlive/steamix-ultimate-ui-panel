import { fetchSafe } from '../utils/network.js';
import { parseM3u } from './localM3uService.js';

export async function fetchDirectM3u(url) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('Geçersiz M3U URL');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetchSafe(url, { signal: controller.signal, headers: { 'User-Agent': 'Steamix/1.0' } });
    if (!res.ok) throw new Error(`M3U çekilemedi: HTTP ${res.status}`);
    const text = await res.text();
    if (!text || !text.includes('#EXTINF')) throw new Error('M3U içeriği geçersiz (EXTINF yok)');
    const entries = parseM3u(text);
    if (!entries.length) throw new Error('M3U içinde kanal bulunamadı');
    return { text, entries, count: entries.length };
  } finally {
    clearTimeout(timeout);
  }
}
