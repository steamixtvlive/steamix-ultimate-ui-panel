import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_APK_ROOT = 'C:\\Users\\sehab\\PROJELER 2026\\Steamix TV\\Steamix TV Hafif Panel Rotasyonlu Gelişmiş 5 DK  Netflix MOD';
const APK_ROOT = process.env.APK_PROJECT_ROOT || DEFAULT_APK_ROOT;
const GRADLE_FILE = path.join(APK_ROOT, 'app', 'build.gradle.kts');

function parseVersion(fileContent) {
  const codeMatch = fileContent.match(/versionCode\s*=\s*(\d+)/);
  const nameMatch = fileContent.match(/versionName\s*=\s*"([^"]+)"/);
  return {
    versionCode: codeMatch ? Number(codeMatch[1]) : null,
    versionName: nameMatch ? nameMatch[1] : null
  };
}

export function getApkVersion() {
  if (!fs.existsSync(GRADLE_FILE)) throw new Error('build.gradle.kts bulunamadı: ' + GRADLE_FILE);
  const content = fs.readFileSync(GRADLE_FILE, 'utf8');
  const v = parseVersion(content);
  return { ...v, path: GRADLE_FILE, apkRoot: APK_ROOT };
}

export function setApkVersion(input) {
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
  const before = content;
  content = content.replace(/versionCode\s*=\s*\d+/, `versionCode = ${code}`);
  content = content.replace(/versionName\s*=\s*"[^"]+"/, `versionName = "${name}"`);
  if (content === before) throw new Error('Sürüm alanları güncellenemedi');
  fs.writeFileSync(GRADLE_FILE, content, 'utf8');
  return { versionCode: code, versionName: name, path: GRADLE_FILE };
}

export function launchBuild() {
  // Spec: SADECE .\gradlew.bat assembleDebug, terminal görünür, canlı izleme
  // Windows only: open visible CMD via `start`
  const cmd = 'cmd';
  const args = ['/c', 'start', 'Steamix Build - assembleDebug', 'cmd', '/k', 'gradlew.bat assembleDebug'];
  const child = spawn(cmd, args, {
    cwd: APK_ROOT,
    shell: true,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return { started: true, apkRoot: APK_ROOT, command: '.\\gradlew.bat assembleDebug' };
}

export function getBuildOutputPath() {
  return path.join(APK_ROOT, 'app', 'build', 'outputs', 'apk', 'debug', 'SteamixTV_v1.0.45_release.apk');
}
