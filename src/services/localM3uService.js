import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_APK_ROOT = 'C:\\Users\\sehab\\PROJELER 2026\\Steamix TV\\Steamix TV Hafif Panel Rotasyonlu Gelişmiş 5 DK  Netflix MOD';
const APK_ROOT = process.env.APK_PROJECT_ROOT || DEFAULT_APK_ROOT;
const M3U_FILE = 'live_channels_rotation.m3u';
const M3U_PATH = path.join(APK_ROOT, 'app', 'src', 'main', 'assets', M3U_FILE);
const TEMP_DIR = path.join(os.tmpdir(), 'steamix-m3u');
const TEMP_M3U = path.join(TEMP_DIR, 'prepared.m3u');

function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export function getM3uPaths() {
  return { apkRoot: APK_ROOT, m3uPath: M3U_PATH, tempM3u: TEMP_M3U };
}

export function readOriginalM3u() {
  if (!fs.existsSync(M3U_PATH)) throw new Error('Orijinal M3U bulunamadı: ' + M3U_PATH);
  return fs.readFileSync(M3U_PATH, 'utf8');
}

export function parseM3u(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line.startsWith('#EXTINF:')) {
      current = { extinf: line, url: '', index: entries.length, rawExtinf: line };
    } else if (current && line && !line.startsWith('#')) {
      current.url = line.trim();
      entries.push(current);
      current = null;
    } else if (current && line === '') {
      // empty url - keep but finalize
      entries.push(current);
      current = null;
    }
  }
  return entries;
}

export function generateM3uFromAssignments(assignedIndices, originalContent) {
  const entries = parseM3u(originalContent);
  const header = '#EXTM3U';
  const selected = [];
  // assignedIndices is array of indices (0-based) to include, preserving original order unless reordered
  const set = new Set((assignedIndices || []).map(n => Number(n)).filter(n => !isNaN(n) && n >= 0 && n < entries.length));
  // If no assignment provided, treat as all
  if (set.size === 0) {
    throw new Error('Hiç kanal seçilmedi');
  }
  for (let i = 0; i < entries.length; i++) {
    if (set.has(i)) selected.push(entries[i]);
  }
  let out = header + '\n';
  for (const e of selected) {
    out += e.extinf + '\n' + e.url + '\n';
  }
  return out;
}

export function writeTempM3u(content) {
  ensureTempDir();
  fs.writeFileSync(TEMP_M3U, content, 'utf8');
  return TEMP_M3U;
}

export function commitTempToOriginal() {
  if (!fs.existsSync(TEMP_M3U)) throw new Error('Hazırlanmış M3U bulunamadı, önce M3U Hazırla yapın');
  const data = fs.readFileSync(TEMP_M3U);
  // Overwrite original atomically
  fs.copyFileSync(TEMP_M3U, M3U_PATH);
  return { bytes: data.length, path: M3U_PATH };
}

export function getTempM3uContent() {
  if (!fs.existsSync(TEMP_M3U)) return null;
  return fs.readFileSync(TEMP_M3U, 'utf8');
}

export function createDesktopM3uTxt(content, filename = 'rotasyon_test.m3u.txt') {
  const desktop = path.join(os.homedir(), 'Desktop');
  const outPath = path.join(desktop, filename);
  fs.writeFileSync(outPath, content, 'utf8');
  return outPath;
}

export function generateM3uFromChannels(channels) {
  // channels: array of {name, url, extinf?}
  let out = '#EXTM3U\n';
  for (const ch of channels) {
    const extinf = ch.extinf || `#EXTINF:-1 tvg-id="" tvg-name="${ch.name}" group-title="${ch.category || 'Genel'}" ,${ch.name}`;
    out += extinf + '\n' + (ch.url || '') + '\n';
  }
  return out;
}
