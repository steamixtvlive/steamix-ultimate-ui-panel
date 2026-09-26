import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireDirectUpstream } from '../src/controllers/streamControllerHelpers.js';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('node:fs');
  const osModule = require('node:os');
  const pathModule = require('node:path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-direct-gate-')) };
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
import { encrypt } from '../src/utils/crypto.js';
import { proxyMovie } from '../src/controllers/streamMediaController.js';

describe('requireDirectUpstream helper', () => {
  it('direct varyantlarini kabul eder', () => {
    const ok = { sendStatus: () => { throw new Error('cagrilmamali'); } };
    expect(requireDirectUpstream({ path: '/live/a/b/1.ts', query: { direct: '1' } }, ok)).toBe(true);
    expect(requireDirectUpstream({ path: '/movie/a/b/1.mp4', query: { redirect: '1' } }, ok)).toBe(true);
    expect(requireDirectUpstream({ path: '/get.php', query: { direct: 'true' } }, ok)).toBe(true);
  });

  it('token-auth yolunu muaf tutar (paylasim proxyde kalir)', () => {
    const ok = { sendStatus: () => { throw new Error('cagrilmamali'); } };
    expect(requireDirectUpstream({ path: '/live/token/auth/5.ts', query: {} }, ok)).toBe(true);
    expect(requireDirectUpstream({ path: '/movie/token/auth/5.mp4', query: {} }, ok)).toBe(true);
  });

  it('direct yoksa 403 verir', () => {
    let code = null;
    const res = { sendStatus: (c) => { code = c; } };
    expect(requireDirectUpstream({ path: '/live/a/b/1.ts', query: {} }, res)).toBe(false);
    expect(code).toBe(403);
    code = null;
    expect(requireDirectUpstream({ path: '/series/a/b/1.mp4', query: { direct: '0' } }, res)).toBe(false);
    expect(code).toBe(403);
  });
});

let umovieId;

function fakeReq(query = {}) {
  return {
    params: { username: 'filmkullanici', password: 'filmpass', stream_id: String(umovieId), ext: 'mp4' },
    query,
    path: `/movie/filmkullanici/filmpass/${umovieId}.mp4`,
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

describe('film direct-only kapisi', () => {
  beforeAll(() => {
    initDb(true);
    db.prepare("INSERT INTO users (username, password, is_active, max_connections) VALUES ('filmkullanici', ?, 1, 0)")
      .run(encrypt('filmpass'));
    const catId = Number(db.prepare(
      "INSERT INTO user_categories (user_id, name, sort_order, type) VALUES (1, 'F', 0, 'movie')"
    ).run().lastInsertRowid);
    const provId = Number(db.prepare(
      'INSERT INTO providers (name, url, username, password, user_id, max_connections) VALUES (?, ?, ?, ?, ?, 0)'
    ).run('up', 'http://ornek.test:8080/get.php?username=u&password=p&type=m3u_plus', 'u', encrypt('p'), 1).lastInsertRowid);
    const chId = Number(db.prepare(
      "INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata) VALUES (?, 888, 'F1', 'movie', '{}')"
    ).run(provId).lastInsertRowid);
    umovieId = Number(db.prepare(
      'INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, 0)'
    ).run(catId, chId).lastInsertRowid);
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
  });

  it('direct=1 yoksa 403 doner', async () => {
    const { out, res } = fakeRes();
    await proxyMovie(fakeReq(), res);
    expect(out.redirected).toBeNull();
    expect(out.status).toBe(403);
  });

  it('direct=1 ile 302 yonlendirir', async () => {
    const { out, res } = fakeRes();
    await proxyMovie(fakeReq({ direct: '1' }), res);
    expect(out.redirected).toBeTruthy();
    expect(out.redirected.code).toBe(302);
    expect(out.redirected.url).toBe('http://ornek.test:8080/movie/u/p/888.mp4');
  });
});
