import { readOriginalM3u, parseM3u, generateM3uFromAssignments, writeTempM3u, commitTempToOriginal, getM3uPaths, getTempM3uContent } from '../services/localM3uService.js';
import { getApkVersion, setApkVersion, launchBuild, getBuildOutputPath } from '../services/localApkService.js';

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
