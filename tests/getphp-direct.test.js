import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('node:fs');
  const osModule = require('node:os');
  const pathModule = require('node:path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-getphp-direct-')) };
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

vi.mock('../src/services/authService.js', () => ({
  getXtreamUser: async () => ({ id: 1, username: 'testkullanicisi', is_share_guest: false })
}));

import db, { initDb } from '../src/database/db.js';
import { encrypt } from '../src/utils/crypto.js';
import { getPlaylist, xmltv } from '../src/controllers/xtreamController.js';

function fakeReq(query) {
  return {
    query,
    protocol: 'https',
    get: (h) => (String(h).toLowerCase() === 'host' ? 'ornek.test' : undefined),
    app: { get: () => false },
  };
}

function fakeRes() {
  const out = { redirected: null, body: '', status: 200 };
  return {
    out,
    res: {
      setHeader() {},
      write: (c) => { out.body += c; },
      end: () => {},
      sendStatus: (c) => { out.status = c; },
      redirect: (c, u) => { out.redirected = { code: c, url: u }; },
    }
  };
}

describe('get.php direct kota modu', () => {
  beforeAll(() => {
    initDb(true);
    db.prepare("INSERT INTO users (username, password, is_active) VALUES ('testkullanicisi', 'x', 1)").run();
    const catId = Number(db.prepare(
      "INSERT INTO user_categories (user_id, name, sort_order, type) VALUES (1, 'Test', 0, 'live')"
    ).run().lastInsertRowid);
    const provId = Number(db.prepare(
      'INSERT INTO providers (name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?)'
    ).run('up', 'http://ornek.test:8080/get.php?username=u&password=p&type=m3u_plus', 'u', encrypt('p'), 1).lastInsertRowid);
    const chId = Number(db.prepare(
      "INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (?, 11, 'K1', 'live')"
    ).run(provId).lastInsertRowid);
    db.prepare(
      'INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, 0)'
    ).run(catId, chId);
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
  });

  it('direct=1 listeyi upstream adresine 302 yonlendirir', async () => {
    const { out, res } = fakeRes();
    await getPlaylist(fakeReq({ username: 't', password: 'x', type: 'm3u_plus', output: 'ts', direct: '1' }), res);
    expect(out.redirected).toBeTruthy();
    expect(out.redirected.code).toBe(302);
    expect(out.redirected.url).toBe('http://ornek.test:8080/get.php?username=u&password=p&type=m3u_plus&output=ts');
  });

  it('parametresiz get.php 403 doner (direct-only)', async () => {
    const { out, res } = fakeRes();
    await getPlaylist(fakeReq({ username: 't', password: 'x', type: 'm3u_plus', output: 'ts' }), res);
    expect(out.redirected).toBeNull();
    expect(out.status).toBe(403);
    expect(out.body).toBe('');
  });

  it('parametresiz xmltv.php 403 doner (direct-only)', async () => {
    const { out, res } = fakeRes();
    await xmltv(fakeReq({ username: 't', password: 'x' }), res);
    expect(out.redirected).toBeNull();
    expect(out.status).toBe(403);
  });

  it('xmltv.php?direct=1 rehberi upstream adresine yonlendirir', async () => {
    const { out, res } = fakeRes();
    await xmltv(fakeReq({ username: 't', password: 'x', direct: '1' }), res);
    expect(out.redirected).toBeTruthy();
    expect(out.redirected.code).toBe(302);
    expect(out.redirected.url).toBe('http://ornek.test:8080/xmltv.php?username=u&password=p');
  });
});
