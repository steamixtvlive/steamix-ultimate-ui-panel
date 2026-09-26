import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('node:fs');
  const osModule = require('node:os');
  const pathModule = require('node:path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-direct-live-')) };
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

vi.mock('../src/utils/network.js', async () => {
  const actual = await vi.importActual('../src/utils/network.js');
  return {
    ...actual,
    fetchSafe: async () => { throw new Error('ag-kapali'); },
  };
});

import db, { initDb } from '../src/database/db.js';
import { encrypt } from '../src/utils/crypto.js';
import { proxyLive } from '../src/controllers/streamController.js';

let uchannelId;

function fakeReq(query = {}) {
  return {
    params: { username: 'yonkullanici', password: 'yonpass', stream_id: String(uchannelId) },
    query,
    path: `/live/yonkullanici/yonpass/${uchannelId}.ts`,
    ip: '127.0.0.1',
    headers: {},
  };
}

function fakeRes() {
  const out = { redirected: null, status: null };
  return {
    out,
    res: {
      setHeader() {},
      redirect: (c, u) => { out.redirected = { code: c, url: u }; },
      sendStatus: (c) => { out.status = c; },
      status: (c) => ({ send: () => { out.status = c; } }),
      headersSent: false,
      destroyed: false,
    }
  };
}

describe('canli varsayilan yonlendirme (kota)', () => {
  beforeAll(() => {
    initDb(true);
    db.prepare("INSERT INTO users (username, password, is_active, max_connections) VALUES ('yonkullanici', ?, 1, 0)")
      .run(encrypt('yonpass'));
    const catId = Number(db.prepare(
      "INSERT INTO user_categories (user_id, name, sort_order, type) VALUES (1, 'Y', 0, 'live')"
    ).run().lastInsertRowid);
    const provId = Number(db.prepare(
      'INSERT INTO providers (name, url, username, password, user_id, max_connections) VALUES (?, ?, ?, ?, ?, 0)'
    ).run('up', 'http://ornek.test:8080/get.php?username=u&password=p&type=m3u_plus', 'u', encrypt('p'), 1).lastInsertRowid);
    const chId = Number(db.prepare(
      "INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata) VALUES (?, 777, 'K1', 'live', '{}')"
    ).run(provId).lastInsertRowid);
    uchannelId = Number(db.prepare(
      'INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, 0)'
    ).run(catId, chId).lastInsertRowid);
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
  });

  it('direct=1 yoksa 403 doner (direct-only)', async () => {
    const { out, res } = fakeRes();
    await proxyLive(fakeReq(), res);
    expect(out.redirected).toBeNull();
    expect(out.status).toBe(403);
  });

  it('direct=1 ile 302 yonlendirir (proxy yok)', async () => {
    const { out, res } = fakeRes();
    await proxyLive(fakeReq({ direct: '1' }), res);
    expect(out.redirected).toBeTruthy();
    expect(out.redirected.code).toBe(302);
    expect(out.redirected.url).toBe('http://ornek.test:8080/live/u/p/777.ts');
  });

  it('direct=1 yoksa ?proxy=1 bile 403 doner (direct-only)', async () => {
    const { out, res } = fakeRes();
    await proxyLive(fakeReq({ proxy: '1' }), res);
    expect(out.redirected).toBeNull();
    expect(out.status).toBe(403);
  });

  it('direct=1 ile birlikte ?proxy=1 proxy yoluna girer (yonlendirme yok)', async () => {
    const { out, res } = fakeRes();
    await proxyLive(fakeReq({ direct: '1', proxy: '1' }), res);
    expect(out.redirected).toBeNull();
    expect(out.status).toBe(502);
  });
});
