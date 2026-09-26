import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('node:fs');
  const osModule = require('node:os');
  const pathModule = require('node:path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-github-backup-')) };
});

vi.mock('../src/config/constants.js', async () => {
  const actual = await vi.importActual('../src/config/constants.js');
  return {
    ...actual,
    DATA_DIR: TEST_DB_DIR,
    CACHE_DIR: `${TEST_DB_DIR}/cache`,
    EPG_CACHE_DIR: `${TEST_DB_DIR}/cache/epg`,
    EPG_DB_PATH: `${TEST_DB_DIR}/epg.db`,
    BCRYPT_ROUNDS: 1,
  };
});

import db, { initDb } from '../src/database/db.js';
import { encryptWithPassword, decryptWithPassword } from '../src/utils/crypto.js';
import {
  backupFileAgeMin,
  backupFileName,
  databaseIsEmpty,
  ensureFreshBackup,
  githubBackupConfig,
  pushBackupToGithub,
  restoreLatestBackupFromGithub,
  stopGithubBackupScheduler,
} from '../src/services/githubBackupService.js';

const TEST_PASS = 'github-backup-test-pass';

function buildBin(payload) {
  return encryptWithPassword(zlib.gzipSync(JSON.stringify(payload)), TEST_PASS);
}

function setGhEnv(extra = {}) {
  process.env.GITHUB_BACKUP_TOKEN = 'gh-test-token';
  process.env.GITHUB_BACKUP_PASSWORD = TEST_PASS;
  process.env.GITHUB_BACKUP_REPO = 'sahip/depo';
  process.env.GITHUB_BACKUP_BRANCH = 'backups';
  Object.assign(process.env, extra);
}

function clearGhEnv() {
  delete process.env.GITHUB_BACKUP_TOKEN;
  delete process.env.GITHUB_BACKUP_PASSWORD;
  delete process.env.RESTORE_PASSWORD;
  delete process.env.GITHUB_BACKUP_REPO;
  delete process.env.GITHUB_BACKUP_BRANCH;
  delete process.env.GITHUB_BACKUP_INTERVAL_MIN;
  delete process.env.SEED_WHITELIST_IPS;
}

describe('program-ici GitHub yedek', () => {
  beforeAll(() => {
    process.env.SEED_WHITELIST_IPS = '9.9.9.9, 8.8.8.8';
    initDb(true);
  });

  afterAll(() => {
    stopGithubBackupScheduler();
    clearGhEnv();
    vi.unstubAllGlobals();
    try { db.close(); } catch {}
    try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearGhEnv();
  });

  it('beyaz liste tohumunu kalici yazar, engeli kaldirir', () => {
    db.prepare("INSERT OR IGNORE INTO blocked_ips (ip, reason, expires_at) VALUES ('9.9.9.9', 'test', 9999999999)").run();
    initDb(true);
    const w = db.prepare('SELECT ip FROM whitelisted_ips WHERE ip IN (?, ?)').all('9.9.9.9', '8.8.8.8');
    expect(w.map((r) => r.ip).sort()).toEqual(['8.8.8.8', '9.9.9.9']);
    const b = db.prepare('SELECT ip FROM blocked_ips WHERE ip = ?').get('9.9.9.9');
    expect(b).toBeFalsy();
  });

  it('yedek dosya adi zaman damgalidir', () => {
    expect(backupFileName(new Date('2026-09-22T18:45:00Z'))).toBe('backups/backup-20260922-1845.bin');
  });

  it('push: export edip backups dalina yazar', async () => {
    db.prepare("INSERT INTO users (username, password, is_active) VALUES ('yedek-kullanicisi', 'x', 1)").run();
    setGhEnv();
    const calls = [];
    vi.stubGlobal('fetch', async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      if (String(url).includes('/git/ref/heads/backups')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (String(url).includes('/git/ref/heads/main')) {
        return { ok: true, status: 200, json: async () => ({ object: { sha: 'mainsahte' } }) };
      }
      if (String(url).includes('/git/refs')) {
        return { ok: true, status: 201, json: async () => ({}) };
      }
      if (String(url).includes('/contents/backups/backup-')) {
        if ((opts.method || 'GET') === 'GET') return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 201, json: async () => ({}) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    const res = await pushBackupToGithub();
    expect(res.success).toBe(true);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeTruthy();
    const payload = JSON.parse(put.body);
    expect(payload.branch).toBe('backups');
    const raw = Buffer.from(payload.content, 'base64');
    const opened = JSON.parse(zlib.gunzipSync(decryptWithPassword(raw, TEST_PASS)).toString('utf8'));
    expect(opened.users.map((u) => u.username)).toContain('yedek-kullanicisi');
  });

  it('restore: son .bin indirip ice aktarir', async () => {
    setGhEnv();
    const bin = buildBin({
      version: 2,
      assignment_provenance_version: 1,
      passwords_plaintext: true,
      users: [{ id: 99, username: 'geri-yuklenen', password: 'x', plain_password: null }],
      providers: [],
      categories: [],
      channels: [],
      mappings: [],
      sync_configs: [],
    });
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('/contents/backups?ref=')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { name: 'backup-20260920-1000.bin', download_url: 'https://x/eski.bin' },
            { name: 'backup-20260922-1800.bin', download_url: 'https://x/yeni.bin' }
          ]
        };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
      };
    });
    const res = await restoreLatestBackupFromGithub();
    expect(res.restored).toBe(true);
    expect(res.name).toBe('backup-20260922-1800.bin');
    const row = db.prepare('SELECT username FROM users WHERE username = ?').get('geri-yuklenen');
    expect(row?.username).toBe('geri-yuklenen');
  });

  it('backups dali bossa main dalindaki yedege duser', async () => {
    setGhEnv();
    const bin = buildBin({
      version: 2,
      assignment_provenance_version: 1,
      passwords_plaintext: true,
      users: [{ id: 98, username: 'mainden-gelen', password: 'x', plain_password: null }],
      providers: [],
      categories: [],
      channels: [],
      mappings: [],
      sync_configs: [],
    });
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('?ref=backups')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (String(url).includes('?ref=main')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ name: 'backup-20260916-1645.bin', download_url: 'https://x/eski.bin' }]
        };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
      };
    });
    const res = await restoreLatestBackupFromGithub();
    expect(res.restored).toBe(true);
    expect(res.name).toBe('backup-20260916-1645.bin');
    const row = db.prepare('SELECT username FROM users WHERE username = ?').get('mainden-gelen');
    expect(row?.username).toBe('mainden-gelen');
  });

  it('databaseIsEmpty bos/dolu ayirt eder', () => {
    expect(databaseIsEmpty()).toBe(false);
    expect(githubBackupConfig().branch).toBe('backups');
  });

  it('backupFileAgeMin dosya adindan yas hesaplar', () => {
    const now = Date.UTC(2026, 8, 26, 13, 50, 0);
    expect(backupFileAgeMin('backup-20260926-1340.bin', now)).toBeCloseTo(10, 0);
    expect(backupFileAgeMin('backup-20260925-1340.bin', now)).toBeCloseTo(1440 + 10, 0);
    expect(backupFileAgeMin('sacma-ad.bin', now)).toBe(Infinity);
    expect(backupFileAgeMin('', now)).toBe(Infinity);
  });

  it('ensureFreshBackup taze yedek varsa yazmaz (restart kanamasi yok)', async () => {
    setGhEnv({ GITHUB_BACKUP_INTERVAL_MIN: '1440' });
    db.prepare("INSERT OR IGNORE INTO users (id, username, password) VALUES (77, 'taze-test', 'x')").run();
    const freshName = backupFileName(new Date()).split('/').pop();
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => [{ name: freshName }]
    }));
    const res = await ensureFreshBackup();
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/taze/);
  });
});
