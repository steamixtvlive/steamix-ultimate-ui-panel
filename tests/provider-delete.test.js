import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('node:fs');
  const osModule = require('node:os');
  const pathModule = require('node:path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-provdel-')) };
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
import { deleteProvider } from '../src/controllers/providerController.js';

describe('saglayici toplu silme', () => {
  let providerId;

  beforeAll(() => {
    initDb(true);
    const uid = Number(db.prepare(
      "INSERT INTO users (username, password, is_active) VALUES ('silt', 'x', 1)"
    ).run().lastInsertRowid);
    const catId = Number(db.prepare(
      "INSERT INTO user_categories (user_id, name, sort_order, type) VALUES (?, 'S', 0, 'live')"
    ).run(uid).lastInsertRowid);
    providerId = Number(db.prepare(
      'INSERT INTO providers (name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?)'
    ).run('sil-beni', 'http://ornek.test', 'u', 'p', uid).lastInsertRowid);
    const chIds = [];
    for (let i = 1; i <= 50; i++) {
      chIds.push(Number(db.prepare(
        'INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, ?, ?)'
      ).run(providerId, 1000 + i, `Kanal ${i}`).lastInsertRowid));
    }
    for (const cid of chIds) {
      db.prepare(
        'INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, 0)'
      ).run(catId, cid);
      db.prepare('INSERT INTO stream_stats (channel_id, views) VALUES (?, 1)').run(cid);
    }
    db.prepare(
      "INSERT INTO sync_configs (provider_id, user_id, enabled, sync_interval) VALUES (?, ?, 1, 'manual')"
    ).run(providerId, uid);
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
  });

  it('tum kanallari ve iliskileri tek seferde siler', () => {
    const t0 = Date.now();
    let body = null;
    const res = { json: (b) => { body = b; }, status: (c) => ({ json: (b) => { body = b; } }) };
    deleteProvider({ user: { is_admin: true }, params: { id: String(providerId) } }, res);
    const secs = (Date.now() - t0) / 1000;
    console.log('SILME:', { body, secs });
    expect(body && body.success).toBe(true);
    expect(db.prepare('SELECT COUNT(*) as c FROM providers WHERE id = ?').get(providerId).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as c FROM provider_channels WHERE provider_id = ?').get(providerId).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as c FROM user_channels').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as c FROM stream_stats').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as c FROM sync_configs WHERE provider_id = ?').get(providerId).c).toBe(0);
    expect(secs).toBeLessThan(10);
  });
});
