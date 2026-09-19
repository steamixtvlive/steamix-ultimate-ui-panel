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

    res.json({ success: true, provider_id: providerId, channels_added: count, message: `${count} kanal rotasyona eklendi` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
