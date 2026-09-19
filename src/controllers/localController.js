import { readOriginalM3u, parseM3u, generateM3uFromAssignments, writeTempM3u, commitTempToOriginal, getM3uPaths, getTempM3uContent, createDesktopM3uTxt, generateM3uFromChannels } from '../services/localM3uService.js';
import { getApkVersion, setApkVersion, launchBuild, getBuildOutputPath, rollbackApkVersion, getVersionHistory, stopBuild } from '../services/localApkService.js';

export const getLocalM3u = (req, res) => {
  try {
    const content = readOriginalM3u();
    const entries = parseM3u(content);
    const { m3uPath } = getM3uPaths();
    // Return both raw for preservation and parsed for UI
    res.json({
      path: m3uPath,
      filename: 'live_channels_rotation.m3u',
      size: Buffer.byteLength(content, 'utf8'),
      count: entries.length,
      content: content.slice(0, 200000), // cap for preview
      full: content,
      entries: entries.slice(0, 2000).map(e => ({ index: e.index, extinf: e.extinf, url: e.url }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const prepareLocalM3u = (req, res) => {
  try {
    const { assignedIndices, assigned } = req.body || {};
    const indices = assignedIndices || assigned;
    if (!Array.isArray(indices) || indices.length === 0) {
      return res.status(400).json({ error: 'assignedIndices boş olamaz (kanal seçin)' });
    }
    const original = readOriginalM3u();
    const generated = generateM3uFromAssignments(indices, original);
    const tmp = writeTempM3u(generated);
    const entries = parseM3u(generated);
    res.json({
      success: true,
      tempPath: tmp,
      count: entries.length,
      size: Buffer.byteLength(generated, 'utf8'),
      message: 'Atanmış kanallar başarıyla M3U dosyasına eklendi ve M3U güncellendi.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const commitLocalM3u = (req, res) => {
  try {
    const result = commitTempToOriginal();
    res.json({ success: true, ...result, message: 'Orijinal assets/ üzerine yazıldı' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const getTempM3u = (req, res) => {
  try {
    const content = getTempM3uContent();
    if (!content) return res.status(404).json({ error: 'Hazır M3U yok' });
    res.json({ content, size: Buffer.byteLength(content, 'utf8'), count: parseM3u(content).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const getVersion = (req, res) => {
  try {
    res.json(getApkVersion());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const updateVersion = (req, res) => {
  try {
    const { version, versionCode, versionName } = req.body || {};
    const input = version ?? versionCode ?? versionName;
    if (!input) return res.status(400).json({ error: 'version gerekli (örn: 46)' });
    const result = setApkVersion(input);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

export const triggerBuild = (req, res) => {
  try {
    const result = launchBuild();
    res.json({ success: true, ...result, output: getBuildOutputPath(), message: 'Build terminali açıldı, canlı izleyebilirsiniz' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const rollbackVersion = (req, res) => {
  try {
    const result = rollbackApkVersion();
    res.json({ success: true, ...result, message: `Sürüm geri alındı: ${result.versionCode} / ${result.versionName}` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

export const getHistory = (req, res) => {
  try {
    res.json(getVersionHistory());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const stopBuildCtrl = (req, res) => {
  try {
    res.json(stopBuild());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const createDesktopM3u = async (req, res) => {
  try {
    const { channels, user_id } = req.body || {};
    let list = channels;
    // Eğer channels yoksa, seçili kullanıcının atanmış kanallarını DB'den al
    if (!list || !Array.isArray(list) || list.length === 0) {
      if (!user_id) return res.status(400).json({ error: 'channels veya user_id gerekli' });
      const db = (await import('../database/db.js')).default;
      // Basit: user_channels + provider_channels join ile al
      const rows = db.prepare(`
        SELECT pc.name, pc.logo, pc.epg_channel_id, pc.stream_type, uc.custom_name, pc.metadata, cat.name as category_name, pc.id as pc_id, p.url as provider_url, p.username as provider_user, p.password as provider_pass
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        JOIN providers p ON p.id = pc.provider_id
        WHERE cat.user_id = ?
        ORDER BY cat.sort_order, uc.sort_order
      `).all(Number(user_id));
      // Tüm kategoriler ve kanallar - bütün düzenlenmiş liste
      list = rows.map(r => {
        let url = '';
        try {
          const meta = r.metadata ? JSON.parse(r.metadata) : null;
          url = meta?.url || meta?.stream_url || meta?.direct_source || '';
        } catch {}
        if (!url) {
          // Provider base URL + stream_id ile oluştur (direct M3U için)
          const base = r.provider_url ? r.provider_url.replace(/\/+$/, '') : '';
          // Direct source varsa kullan, yoksa base + id
          url = base ? `${base}/live/${r.provider_user}/${r.provider_pass}/${r.pc_id}.ts` : `http://placeholder/${r.name}`;
        }
        const cat = r.category_name || 'Genel';
        return { name: r.custom_name || r.name, url, category: cat, extinf: `#EXTINF:-1 tvg-id="${r.epg_channel_id||''}" tvg-name="${r.name}" tvg-logo="${r.logo||''}" group-title="${cat}",${r.custom_name||r.name}` };
      });
      if (!list.length) return res.status(400).json({ error: 'Atanmış listede kanal yok, önce providerdan ekleyin' });
    }
    // Yeni yapı: önce yeni kategoriler (provider kanalları), sonra varsayılan VOD/dizi/film (orijinal M3U'dan, ham ctn34 hariç)
    // Varsayılan VOD/dizi/film'i orijinal dosyadan al (group-title VOD/Series/Film olanlar)
    let defaultVodEntries = [];
    try {
      const orig = readOriginalM3u();
      const origEntries = parseM3u(orig);
      defaultVodEntries = origEntries.filter(e => {
        const gt = (e.extinf.match(/group-title="([^"]+)"/) || [])[1] || '';
        return /vod|film|dizi|series|movie/i.test(gt);
      });
    } catch {}
    // Yeni provider kanalları (list) + varsayılan VOD'lar
    const combined = [...list];
    for (const e of defaultVodEntries) {
      combined.push({ name: (e.extinf.match(/,(.*)$/)||[])[1]?.trim()||'VOD', url: e.url, category: (e.extinf.match(/group-title="([^"]+)"/)||[])[1]||'VOD', extinf: e.extinf });
    }
    const m3u = generateM3uFromChannels(combined);
    const outPath = createDesktopM3uTxt(m3u, `rotasyon_test_${Date.now()}.m3u.txt`);
    res.json({ success: true, path: outPath, count: combined.length, size: Buffer.byteLength(m3u, 'utf8') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
