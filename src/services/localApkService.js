import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const DEFAULT_APK_ROOT = 'C:\\Users\\sehab\\PROJELER 2026\\Steamix TV\\Steamix TV Hafif Panel Rotasyonlu Gelişmiş 5 DK  Netflix MOD';
const APK_ROOT = process.env.APK_PROJECT_ROOT || DEFAULT_APK_ROOT;
const GRADLE_FILE = path.join(APK_ROOT, 'app', 'build.gradle.kts');
const VERSION_HISTORY_FILE = path.join(APK_ROOT, '.version_history.json');

function parseVersion(fileContent) {
  const codeMatch = fileContent.match(/versionCode\s*=\s*(\d+)/);
  const nameMatch = fileContent.match(/versionName\s*=\s*"([^"]+)"/);
  return {
    versionCode: codeMatch ? Number(codeMatch[1]) : null,
    versionName: nameMatch ? nameMatch[1] : null
  };
}

export function getApkVersion() {
  if (!fs.existsSync(APK_ROOT)) throw new Error('Netflix MOD klasörü bulunamadı — bu özellik sadece localhost\'ta (kendi PC\'nizde) çalışır. Paneli http://localhost:3000 üzerinden açın. Yol: ' + APK_ROOT);
  if (!fs.existsSync(GRADLE_FILE)) throw new Error('build.gradle.kts bulunamadı: ' + GRADLE_FILE + ' — Netflix MOD klasörünü kontrol edin.');
  const content = fs.readFileSync(GRADLE_FILE, 'utf8');
  const v = parseVersion(content);
  return { ...v, path: GRADLE_FILE, apkRoot: APK_ROOT };
}

export function setApkVersion(input) {
  if (!fs.existsSync(APK_ROOT)) throw new Error('Netflix MOD klasörü bulunamadı — bu özellik sadece localhost\'ta çalışır. Yol: ' + APK_ROOT);
  if (!fs.existsSync(GRADLE_FILE)) throw new Error('build.gradle.kts bulunamadı: ' + GRADLE_FILE);
  let raw = String(input).trim();
  if (!raw) throw new Error('Sürüm numarası boş olamaz');
  // Accept "46" or "1.0.46" - extract numeric code
  let code;
  let name;
  if (/^\d+$/.test(raw)) {
    code = Number(raw);
    name = `1.0.${code}`;
    // Keep legacy offset? Spec says senkronize, so use same number
  } else if (/^\d+\.\d+\.\d+/.test(raw)) {
    name = raw;
    const parts = raw.split('.');
    code = Number(parts[parts.length - 1]);
    if (isNaN(code)) throw new Error('Geçersiz sürüm formatı');
  } else {
    throw new Error('Geçersiz sürüm formatı (örn: 46 veya 1.0.46)');
  }
  if (code < 1 || code > 9999) throw new Error('versionCode 1-9999 aralığında olmalı');

  let content = fs.readFileSync(GRADLE_FILE, 'utf8');
  const current = parseVersion(content);
  if (current.versionCode === code && current.versionName === name) {
    return { versionCode: code, versionName: name, path: GRADLE_FILE, unchanged: true };
  }
  // Push current to history for rollback
  const hist = readHistory();
  hist.push({ versionCode: current.versionCode, versionName: current.versionName, at: new Date().toISOString() });
  writeHistory(hist);
  const before = content;
  content = content.replace(/versionCode\s*=\s*\d+/, `versionCode = ${code}`);
  content = content.replace(/versionName\s*=\s*"[^"]+"/, `versionName = "${name}"`);
  if (content === before) throw new Error('Sürüm alanları güncellenemedi');
  fs.writeFileSync(GRADLE_FILE, content, 'utf8');
  return { versionCode: code, versionName: name, path: GRADLE_FILE };
}

export function launchBuild() {
  if (!fs.existsSync(APK_ROOT)) throw new Error('Netflix MOD klasörü bulunamadı — bu özellik sadece localhost\'ta çalışır. Yol: ' + APK_ROOT);
  if (!fs.existsSync(path.join(APK_ROOT, 'gradlew.bat'))) throw new Error('gradlew.bat bulunamadı, Netflix MOD klasörünü kontrol edin: ' + APK_ROOT);
  // Spec: SADECE .\gradlew.bat assembleDebug, terminal görünür, canlı izleme
  // Windows `start` başlığı tırnak içinde, komut .\ ile tam spec uyumlu
  spawn('cmd', ['/c', 'start', 'Steamix Build - assembleDebug', 'cmd', '/k', '.\\gradlew.bat assembleDebug'], {
    cwd: APK_ROOT,
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  }).unref();
  return { started: true, apkRoot: APK_ROOT, command: '.\\gradlew.bat assembleDebug' };
}

export function stopBuild() {
  try { execSync('taskkill /F /IM java.exe 2>nul', { stdio: 'ignore' }); } catch {}
  try { execSync('taskkill /F /IM gradle.exe 2>nul', { stdio: 'ignore' }); } catch {}
  try { execSync('taskkill /F /FI "WINDOWTITLE eq Steamix Build - assembleDebug" 2>nul', { stdio: 'ignore' }); } catch {}
  return { stopped: true, message: 'Build durdurma komutu gönderildi' };
}

export function getBuildOutputPath() {
  return path.join(APK_ROOT, 'app', 'build', 'outputs', 'apk', 'debug', 'SteamixTV_v1.0.45_release.apk');
}

function readHistory() {
  try {
    if (!fs.existsSync(VERSION_HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(VERSION_HISTORY_FILE, 'utf8'));
  } catch { return []; }
}

function writeHistory(hist) {
  fs.writeFileSync(VERSION_HISTORY_FILE, JSON.stringify(hist.slice(-20), null, 2), 'utf8');
}

export function getVersionHistory() {
  return readHistory();
}

export function rollbackApkVersion() {
  const hist = readHistory();
  if (hist.length === 0) throw new Error('Geri alınacak sürüm yok');
  const prev = hist.pop();
  let content = fs.readFileSync(GRADLE_FILE, 'utf8');
  content = content.replace(/versionCode\s*=\s*\d+/, `versionCode = ${prev.versionCode}`);
  content = content.replace(/versionName\s*=\s*"[^"]+"/, `versionName = "${prev.versionName}"`);
  fs.writeFileSync(GRADLE_FILE, content, 'utf8');
  writeHistory(hist);
  return { versionCode: prev.versionCode, versionName: prev.versionName, path: GRADLE_FILE, rolledBack: true };
}
