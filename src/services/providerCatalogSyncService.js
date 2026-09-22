import { Xtream } from '@iptv/xtream-api';
import { fetchSafe } from '../utils/network.js';
import { parseM3uStream } from '../utils/playlistParser.js';

export function createXtreamClient(provider) {
  const baseUrl = xtreamApiBase((provider.url || '').trim());
  return new Xtream({ url: baseUrl, username: provider.username, password: provider.password });
}

// M3U linkiyle eklenen sağlayıcılarda (get.php / .m3u) API çağrıları host
// köküne yapılır; yoksa player_api.php çöp URL'ye gider, dakikalarca asılı kalır.
export function xtreamApiBase(rawUrl) {
  try {
    const normalized = /^https?:\/\//i.test(rawUrl || '') ? rawUrl : `http://${rawUrl || ''}`;
    const u = new URL(normalized);
    if (!u.host) throw new Error('no host');
    return `${u.protocol}//${u.host}`;
  } catch {
    return (rawUrl || '').replace(/\/+$/, '');
  }
}

export async function fetchProviderCatalog(provider, xtream) {
  const baseUrl = xtreamApiBase(provider.url);
  const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}`;
  // Provider'a ozel User-Agent (panelde provider formunda girilir); bazi hostlar
  // varsayilan node UA'yi engelleyip bos doner -> 0 kanal. Bos ise gonderme.
  const uaHeaders = provider.user_agent && String(provider.user_agent).trim()
    ? { 'User-Agent': String(provider.user_agent).trim() }
    : {};
  const allChannels = [];
  const allCategories = [];
  const completeStreamTypes = new Set();
  const snapshotStates = new Map();
  const errors = { live: null, movie: null, series: null };

  // 1. Live & M3U Fallback
  try {
    let liveChans = [];
    let m3uMode = false;
    let liveFetchComplete = false;

    // Try Xtream API
    try {
      liveChans = await xtream.getChannels();
      liveFetchComplete = Array.isArray(liveChans);
    } catch (e) {
      errors.live = `Xtream API: ${e?.message || e}`;
      try {
        const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_live_streams`, { timeout: 60000, headers: uaHeaders });
        if (resp.ok) {
          const contentType = resp.headers?.get?.('content-type');
          if (contentType && contentType.includes('application/json')) {
            liveChans = await resp.json();
            liveFetchComplete = Array.isArray(liveChans);
          } else {
            errors.live = `Xtream API: JSON donmedi (${contentType || 'bilinmiyor'})`;
          }
        } else {
          errors.live = `Xtream API: HTTP ${resp.status}`;
        }
      } catch (e2) { errors.live = `Xtream API: ${e2?.message || e2}`; }
    }

    // M3U Fallback if Xtream failed or empty
    if (!Array.isArray(liveChans) || liveChans.length === 0) {
      const apiFetchComplete = liveFetchComplete;
      liveFetchComplete = false;
      try {
        // Try fetching as M3U
        const m3uResp = await fetchSafe(provider.url, { timeout: 60000, headers: uaHeaders }); // Use original URL
        if (m3uResp.ok) {
          const parsed = await parseM3uStream(m3uResp.body);
          if (parsed.isM3u) {
            console.debug('  📂 Detected M3U Playlist');
            m3uMode = true;
            liveFetchComplete = true;

            // Map to Xtream format
            parsed.channels.forEach((ch, idx) => {
              // Generate a stable integer ID from URL
              let hash = 0;
              for (let i = 0; i < ch.url.length; i++) {
                hash = ((hash << 5) - hash) + ch.url.charCodeAt(i);
                hash |= 0;
              }
              const streamId = Math.abs(hash);

              liveChans.push({
                num: idx + 1,
                name: ch.name,
                stream_type: ch.stream_type || 'live',
                stream_id: streamId,
                stream_icon: ch.logo,
                epg_channel_id: ch.epg_id,
                category_id: ch.category_id,
                category_type: ch.stream_type || 'live',
                metadata: ch.metadata || {}, // Store parsed headers/drm (Optimization: avoid double stringify)
                container_extension: ch.url.includes('.mpd') ? 'mpd' : 'ts',
                original_url: ch.url // Pass original URL for proxying later?
              });
            });

            parsed.categories.forEach(cat => {
              allCategories.push({
                category_id: cat.category_id,
                category_name: cat.category_name,
                category_type: cat.category_type
              });
            });
          }
        }
      } catch (e) { console.error('M3U fallback error:', e.message); errors.live = `M3U: ${e.message}`; }
      if (!liveFetchComplete && apiFetchComplete) liveFetchComplete = true;
      if (Array.isArray(liveChans) && liveChans.length === 0 && !errors.live) {
        errors.live = 'Xtream ve M3U denendi, kanal donmedi (URL/kullanici/sifre kontrol edin)';
      }
    }

    // Normalize
    if (Array.isArray(liveChans)) {
      liveChans.forEach(c => {
        if (!m3uMode) {
          c.stream_type = 'live';
          c.category_type = 'live';
        }
        allChannels.push(c);
      });
      if (liveFetchComplete) completeStreamTypes.add('live');
      if (liveFetchComplete) snapshotStates.set('live', { count: liveChans.length });
    }

    if (!m3uMode) {
      const respCat = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_live_categories`, { timeout: 60000, headers: uaHeaders });
      if (respCat.ok) {
        const cats = await respCat.json();
        if (Array.isArray(cats)) {
          cats.forEach(c => { c.category_type = 'live'; allCategories.push(c); });
        }
      } else if (!errors.live) {
        errors.live = `Kategori: HTTP ${respCat.status}`;
      }
    }
  } catch (e) { console.error('Live sync error:', e); errors.live = errors.live || String(e?.message || e); }

  // 2. Movies (VOD)
  try {
    console.debug('Fetching VOD streams...');
    const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_vod_streams`, { timeout: 60000, headers: uaHeaders });
    if (resp.ok) {
      const vods = await resp.json();
      console.debug(`Fetched ${Array.isArray(vods) ? vods.length : 'invalid'} VODs`);
      if (Array.isArray(vods)) {
        vods.forEach(c => {
          c.stream_type = 'movie';
          c.category_type = 'movie';
          allChannels.push(c);
        });
        completeStreamTypes.add('movie');
        snapshotStates.set('movie', { count: vods.length });
      }
    } else {
      console.error(`VOD fetch failed: ${resp.status}`);
      errors.movie = `VOD: HTTP ${resp.status}`;
    }

    const respCat = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_vod_categories`, { timeout: 60000, headers: uaHeaders });
    if (respCat.ok) {
      const cats = await respCat.json();
      if (Array.isArray(cats)) {
        cats.forEach(c => { c.category_type = 'movie'; allCategories.push(c); });
      }
    }
  } catch (e) { console.error('VOD sync error:', e); errors.movie = errors.movie || String(e?.message || e); }

  // 3. Series
  try {
    const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_series`, { timeout: 60000, headers: uaHeaders });
    if (resp.ok) {
      const series = await resp.json();
      if (Array.isArray(series)) {
        series.forEach(c => {
          c.stream_type = 'series';
          c.category_type = 'series';
          // Map series fields to common format
          c.stream_id = c.series_id;
          c.stream_icon = c.cover;
          allChannels.push(c);
        });
        completeStreamTypes.add('series');
        snapshotStates.set('series', { count: series.length });
      }
    } else {
      errors.series = `Dizi: HTTP ${resp.status}`;
    }

    const respCat = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_series_categories`, { timeout: 60000, headers: uaHeaders });
    if (respCat.ok) {
      const cats = await respCat.json();
      if (Array.isArray(cats)) {
        cats.forEach(c => { c.category_type = 'series'; allCategories.push(c); });
      }
    }
  } catch (e) { console.error('Series sync error:', e); errors.series = errors.series || String(e?.message || e); }

  return { allChannels, allCategories, completeStreamTypes, snapshotStates, errors };
}

