import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('node:fs');
  const osModule = require('node:os');
  const pathModule = require('node:path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-bulk-assign-')) };
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
import { bulkAddChannels } from '../src/controllers/channelController.js';

describe('tumunu aktar (toplu atama)', () => {
  let catId;
  let providerId;

  beforeAll(() => {
    initDb(true);
    const uid = Number(db.prepare(
      "INSERT INTO users (username, password, is_active) VALUES ('toplu', 'x', 1)"
    ).run().lastInsertRowid);
    catId = Number(db.prepare(
      "INSERT INTO user_categories (user_id, name, sort_order, type) VALUES (?, 'Hedef', 0, 'live')"
    ).run(uid).lastInsertRowid);
    providerId = Number(db.prepare(
      'INSERT INTO providers (name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?)'
    ).run('p1', 'http://ornek.test', 'u', 'p', uid).lastInsertRowid);
    const names = ['Spor 1', 'Spor 2', 'Haber 1', 'Film 1'];
    names.forEach((n, i) => {
      db.prepare(
        "INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (?, ?, ?, 'live')"
      ).run(providerId, 5000 + i, n);
    });
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
  });

  function callBulk(body) {
    let out = null;
    const res = { json: (b) => { out = b; }, status: (c) => ({ json: (b) => { out = { ...b, __status: c }; } }) };
    bulkAddChannels(
      { user: { is_admin: true, id: 1 }, params: { catId: String(catId) }, body },
      res
    );
    return out;
  }

  it('filtreye uyan tum kanallari tek seferde atar', () => {
    const out = callBulk({ provider_id: providerId, type: 'live', search: 'spor' });
    expect(out.success).toBe(true);
    expect(out.total).toBe(2);
    expect(out.added).toBe(2);
    const n = db.prepare('SELECT COUNT(*) as c FROM user_channels WHERE user_category_id = ?').get(catId).c;
    expect(n).toBe(2);
  });

  it('ikinci calistirmada mevcutlari sayar, kopya olusturmaz', () => {
    callBulk({ provider_id: providerId, type: 'live', search: '' });
    const out = callBulk({ provider_id: providerId, type: 'live', search: '' });
    expect(out.total).toBe(4);
    expect(out.added).toBe(0);
    expect(out.existing).toBe(4);
    const n = db.prepare('SELECT COUNT(*) as c FROM user_channels WHERE user_category_id = ?').get(catId).c;
    expect(n).toBe(4);
  });
});
