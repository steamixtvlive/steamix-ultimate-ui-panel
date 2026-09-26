// Program içi GitHub yedekleme: GitHub Actions YOKTUR.
// Ayarlar/kullanıcılar/sağlayıcılar .bin'e çevrilip `backups` dalına yazılır;
// açılışta DB boşsa son yedek otomatik geri yüklenir (Render free silinmelerine karşı).
import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../database/db.js';
import { exportData, importData } from '../controllers/systemDataController.js';

const API = 'https://api.github.com';

export function githubBackupConfig() {
  const token = (process.env.GITHUB_BACKUP_TOKEN || '').trim();
  const password = (process.env.GITHUB_BACKUP_PASSWORD || process.env.RESTORE_PASSWORD || '').trim();
  const repo = (process.env.GITHUB_BACKUP_REPO || 'steamixtvlive/steamix-ultimate-ui-panel').trim();
  const branch = (process.env.GITHUB_BACKUP_BRANCH || 'backups').trim() || 'backups';
  const intervalMin = Math.min(1440, Math.max(10, Number(process.env.GITHUB_BACKUP_INTERVAL_MIN) || 60));
  return { token, password, repo, branch, intervalMin };
}

export function githubBackupEnabled() {
  const { token, password } = githubBackupConfig();
  return Boolean(token && password);
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Steamix-Backup',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function backupFileName(when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `backups/backup-${when.getUTCFullYear()}${p(when.getUTCMonth() + 1)}${p(when.getUTCDate())}-${p(when.getUTCHours())}${p(when.getUTCMinutes())}.bin`;
}

async function ensureBranch({ token, repo, branch }) {
  const headers = githubHeaders(token);
  const refRes = await fetch(`${API}/repos/${repo}/git/ref/heads/${branch}`, { headers });
  if (refRes.ok) return true;
  const mainRes = await fetch(`${API}/repos/${repo}/git/ref/heads/main`, { headers });
  if (!mainRes.ok) throw new Error(`main dalı okunamadı (HTTP ${mainRes.status})`);
  const mainRef = await mainRes.json();
  const createRes = await fetch(`${API}/repos/${repo}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainRef.object.sha })
  });
  if (!createRes.ok) throw new Error(`backups dalı açılamadı (HTTP ${createRes.status})`);
  return true;
}

function exportToBuffer(password) {
  let buffer = null;
  let status = 200;
  let body = null;
  const res = {
    setHeader() {},
    send: (buf) => { buffer = Buffer.from(buf); },
    status: (c) => ({ json: (b) => { status = c; body = b; } }),
    json: (b) => { body = b; }
  };
  exportData({ user: { is_admin: true }, body: { password }, query: {} }, res);
  if (!buffer) throw new Error(`Export boş döndü (HTTP ${status}): ${body && body.error ? body.error : ''}`);
  return buffer;
}

export async function pushBackupToGithub() {
  const cfg = githubBackupConfig();
  if (!cfg.token || !cfg.password) return recordPush(false, 'GITHUB_BACKUP_TOKEN / şifre yok');
  // Bos DB asla yedeklenmez: zaman damgasi en yeni oldugu icin sonraki
  // acilislarda geri yukleme bos dosyayi secer ve gercek veri kaybolur.
  if (databaseIsEmpty()) return recordPush(false, 'DB bos - yedek yazilmadi');
  await ensureBranch(cfg);
  const buffer = exportToBuffer(cfg.password);
  const name = backupFileName();
  const headers = githubHeaders(cfg.token);
  const existingRes = await fetch(`${API}/repos/${cfg.repo}/contents/${name}?ref=${cfg.branch}`, { headers });
  const existing = existingRes.ok ? await existingRes.json() : null;
  const putRes = await fetch(`${API}/repos/${cfg.repo}/contents/${name}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `auto backup ${new Date().toISOString()}`,
      content: buffer.toString('base64'),
      branch: cfg.branch,
      ...(existing && existing.sha ? { sha: existing.sha } : {})
    })
  });
  if (!putRes.ok) throw new Error(`Yedek yazılamadı (HTTP ${putRes.status})`);
  console.info(`✅ GitHub yedeği yazıldı: ${name} (${buffer.length} bytes)`);
  recordPush(true, `${name} (${buffer.length} bytes)`);
  return { success: true, name, bytes: buffer.length };
}

// Zamanlayici ve manuel tetikleme hatalarini kaydeder (panelde gorunur).
export async function runPushBackup() {
  try {
    return await pushBackupToGithub();
  } catch (e) {
    recordPush(false, e.message);
    return { success: false, error: e.message };
  }
}

async function downloadBackupFile(url, token) {
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) throw new Error(`Yedek indirilemedi (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function restoreLatestBackupFromGithub() {
  const cfg = githubBackupConfig();
  const headers = githubHeaders(cfg.token);
  // Önce backups dalı, yoksa main dalındaki eski yedekler (geri uyumluluk).
  const branches = [cfg.branch];
  if (!branches.includes('main')) branches.push('main');
  let files = null;
  for (const branch of branches) {
    const listRes = await fetch(`${API}/repos/${cfg.repo}/contents/backups?ref=${branch}`, { headers });
    if (!listRes.ok) continue;
    const listed = await listRes.json();
    const bins = (Array.isArray(listed) ? listed : [])
      .filter((f) => f && typeof f.name === 'string' && f.name.endsWith('.bin'));
    if (bins.length > 0) {
      files = bins;
      break;
    }
  }
  if (!files) return { restored: false, reason: 'Yedek bulunamadı' };
  if (!cfg.password) return { restored: false, reason: 'Şifre yok (GITHUB_BACKUP_PASSWORD)' };
  const latest = [...files].sort((a, b) => b.name.localeCompare(a.name))[0];
  const buf = await downloadBackupFile(latest.download_url, cfg.token);
  const tmpPath = path.join(os.tmpdir(), `restore-${Date.now()}.bin`);
  fs.writeFileSync(tmpPath, buf);
  let status = 0;
  let body = null;
  const res = {
    status: (c) => ({ json: (b) => { status = c; body = b; } }),
    json: (b) => { body = b; }
  };
  await importData(
    { user: { is_admin: true }, body: { password: cfg.password }, file: { path: tmpPath } },
    res
  );
  // importData başarıda res.json ile döner (status çağrılmayabilir).
  if (body && body.success) {
    console.info(`✅ Otomatik geri yükleme tamam: ${latest.name}`);
    return { restored: true, name: latest.name };
  }
  throw new Error(`Geri yükleme başarısız (HTTP ${status}): ${(body && body.error) || ''}`);
}

let backupTimer = null;
let firstPushTimer = null;
let lastPush = null; // { at, ok, detail } — panelden tetiklenen/otomatik push sonucu

export function getLastPushInfo() {
  return lastPush;
}

function recordPush(ok, detail) {
  lastPush = { at: new Date().toISOString(), ok, detail };
  return lastPush;
}

// Dalaki en yeni yedegin yasi (dakika). Yoksa/okunamazsa sonsuz doner
// (yedek gerekli); liste hatasinda 0 doner (spam olmasin, araliga birakilir).
export function backupFileAgeMin(fileName, nowMs = Date.now()) {
  const m = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.bin$/.exec(fileName || '');
  if (!m) return Infinity;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return (nowMs - t) / 60000;
}

export async function latestBackupAgeMin(cfg) {
  try {
    const listRes = await fetch(`${API}/repos/${cfg.repo}/contents/backups?ref=${cfg.branch}`, {
      headers: githubHeaders(cfg.token)
    });
    if (!listRes.ok) return Infinity;
    const listed = await listRes.json();
    const bins = (Array.isArray(listed) ? listed : [])
      .map((f) => f && f.name)
      .filter((n) => typeof n === 'string' && n.endsWith('.bin'))
      .sort();
    if (!bins.length) return Infinity;
    return backupFileAgeMin(bins[bins.length - 1]);
  } catch {
    return 0;
  }
}

// Acilis yedegi: dalda taze yedek varsa YAZMA (restart'lar kotayi delmesin).
export async function ensureFreshBackup() {
  const cfg = githubBackupConfig();
  if (!cfg.token || !cfg.password) return recordPush(false, 'GITHUB_BACKUP_TOKEN / şifre yok');
  if (databaseIsEmpty()) return recordPush(false, 'DB bos - yedek yazilmadi');
  const age = await latestBackupAgeMin(cfg);
  if (age < cfg.intervalMin) {
    return recordPush(false, `Yedek taze (${Math.max(0, Math.round(age))} dk) - yazilmadi`);
  }
  return runPushBackup();
}

export function startGithubBackupScheduler() {
  if (backupTimer) clearInterval(backupTimer);
  if (firstPushTimer) clearTimeout(firstPushTimer);
  const cfg = githubBackupConfig();
  if (!cfg.token || !cfg.password) {
    console.info('ℹ️ Program-içi GitHub yedek kapalı (GITHUB_BACKUP_TOKEN / şifre yok)');
    return false;
  }
  console.info(`💾 Program-içi GitHub yedek açık: her ${cfg.intervalMin} dk → ${cfg.repo}@${cfg.branch}`);
  // Acilis kontrolu (60 sn): taze yedek varsa atlanir; yoksa/eskiyse yazilir.
  // Boylece sik restart'lar her seferinde MB'larca yedek yazmaz.
  firstPushTimer = setTimeout(() => {
    ensureFreshBackup().then((r) => { if (r && r.success === false) console.error('İlk otomatik yedek hatası:', r.error); });
  }, 60 * 1000);
  backupTimer = setInterval(() => {
    runPushBackup().then((r) => { if (r && r.success === false) console.error('Otomatik yedek hatası:', r.error); });
  }, cfg.intervalMin * 60 * 1000);
  return true;
}

export function stopGithubBackupScheduler() {
  if (backupTimer) clearInterval(backupTimer);
  if (firstPushTimer) clearTimeout(firstPushTimer);
  backupTimer = null;
  firstPushTimer = null;
}

export function databaseIsEmpty() {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM users').get();
    return !row || Number(row.c) === 0;
  } catch {
    return false;
  }
}
