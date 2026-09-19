import { fetchDirectM3u } from '../services/directM3uService.js';
import { readOriginalM3u, writeTempM3u, commitTempToOriginal } from '../services/localM3uService.js';
import db from '../database/db.js';

export const importDirectM3u = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Access denied' });
    const { url, user_id } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url gerekli' });
    if (!user_id) return res.status(400).json({ error: 'user_id gerekli' });

    const { entries, count } = await fetchDirectM3u(url);

    // Provider olarak kaydet (varsa güncelle, yoksa oluştur)
    let providerId = null;
    const existing = db.prepare('SELECT id FROM providers WHERE url = ? AND user_id = ?').get(url, Number(user_id));
    if (existing) {
      providerId = existing.id;
    } else {
      // URL'den username/password çıkar (get.php?username=&password=)
      let username = 'direct';
      let password = 'direct';
      try {
        const u = new URL(url);
        username = u.searchParams.get('username') || username;
        password = u.searchParams.get('password') || password;
      } catch {}
      const name = `Direct M3U ${new Date().toLocaleDateString('tr-TR')}`;
      const encPass = password; // will be encrypted by providerController logic? For now store direct
      const info = db.prepare('INSERT INTO providers (name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?)').run(name, url, username, encPass, Number(user_id));
      providerId = info.lastInsertRowid;
    }

    // Rotasyona ekle: orijinal M3U'ya append et (koru formatı), sonra temp'e yaz ve commit
    const original = readOriginalM3u();
    let newContent = original.trimEnd() + '\n';
    for (const e of entries) {
      newContent += e.extinf + '\n' + e.url + '\n';
    }
    writeTempM3u(newContent);
    commitTempToOriginal();

    // UI'de kategorili görünmesi için DB'ye de ekle (limitli: ilk 5000 kanal, yoksa kategori listesi şişer)
    const maxDbChannels = 5000;
    const dbEntries = entries.slice(0, maxDbChannels);
    const catMap = new Map();
    for (const e of dbEntries) {
      const m = e.extinf.match(/group-title="([^"]+)"/);
      const cat = m ? m[1] : 'Genel';
      if (!catMap.has(cat)) {
        let existingCat = db.prepare('SELECT id FROM user_categories WHERE user_id = ? AND name = ?').get(Number(user_id), cat);
        let catId;
        if (existingCat) catId = existingCat.id;
        else {
          const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM user_categories WHERE user_id = ?').get(Number(user_id)).m;
          const ins = db.prepare('INSERT INTO user_categories (user_id, name, sort_order, type) VALUES (?, ?, ?, ?)').run(Number(user_id), cat, maxOrder + 1, 'live');
          catId = ins.lastInsertRowid;
          // mapping de oluştur
          db.prepare('INSERT OR IGNORE INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type) VALUES (?, ?, ?, ?, ?, ?)').run(providerId, Number(user_id), cat, cat, catId, 'live');
        }
        catMap.set(cat, catId);
      }
    }
    // Provider channels ve user_channels oluştur
    const insertProvChan = db.prepare('INSERT OR IGNORE INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertUserChan = db.prepare('INSERT OR IGNORE INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');
    let sortOrder = 0;
    for (const e of dbEntries) {
      const m = e.extinf.match(/group-title="([^"]+)"/);
      const cat = m ? m[1] : 'Genel';
      const catId = catMap.get(cat);
      const nameMatch = e.extinf.match(/,(.*)$/);
      const name = nameMatch ? nameMatch[1].trim() : `Channel ${sortOrder}`;
      const tvgId = (e.extinf.match(/tvg-id="([^"]+)"/) || [])[1] || '';
      const logo = (e.extinf.match(/tvg-logo="([^"]+)"/) || [])[1] || '';
      const remoteId = 200000 + sortOrder;
      const provChan = insertProvChan.run(providerId, remoteId, name, cat, logo, 'live', tvgId);
      let provChanId = provChan.lastInsertRowid;
      if (!provChanId) {
        const existing = db.prepare('SELECT id FROM provider_channels WHERE provider_id = ? AND remote_stream_id = ?').get(providerId, remoteId);
        provChanId = existing?.id;
      }
      if (provChanId && catId) {
        insertUserChan.run(catId, provChanId, sortOrder);
      }
      sortOrder++;
    }

    res.json({ success: true, provider_id: providerId, channels_added: count, db_channels_added: Math.min(count, maxDbChannels), message: `${count} kanal rotasyona eklendi` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
