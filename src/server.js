import './utils/logger.js';
import cluster from 'cluster';
import os from 'os';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { createClient } from 'redis';
import dotenv from 'dotenv';

import app from './app.js';
import db, { initDb } from './database/db.js';
import { initEpgDb } from './database/epgDb.js';
import streamManager from './services/streamManager.js';
import { startSyncScheduler, startEpgScheduler, startCleanupScheduler, startGeoIpUpdater } from './services/schedulerService.js';
import { startSSDP } from './services/ssdpService.js';
import { createDefaultAdmin } from './services/authService.js';
import { PORT } from './config/constants.js';

dotenv.config();

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Validate ffmpeg binary is executable for current runtime user (important for non-root containers)
try {
  if (!ffmpegPath) {
    console.error('FFmpeg binary path is not available. Transcoding features may not work.');
  } else {
    fs.accessSync(ffmpegPath, fs.constants.X_OK);
  }
} catch (e) {
  console.error(`FFmpeg is not executable by current user (${process.getuid?.() ?? 'n/a'}). Transcoding may fail:`, e.message);
}

// Initialize Stream Manager (Redis or SQLite)
let redisClient = null;

(async () => {
  if (process.env.REDIS_URL) {
      try {
        redisClient = createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.error('Redis Client Error', err));
        await redisClient.connect();
      } catch (e) {
        console.error('Failed to connect to Redis, falling back to SQLite:', e);
        redisClient = null;
      }
  }

  // Render free: single worker mode to save RAM (DISABLE_CLUSTER=true)
  if (process.env.DISABLE_CLUSTER === 'true') {
    initDb(true);
    initEpgDb();
    // NOT: IP listelerine dokunulmaz (beyaz/kara liste kalıcıdır, panelden yönetilir).
    streamManager.init(db, redisClient);
    await createDefaultAdmin();
    try { const bcrypt = await import('bcrypt'); const h = await bcrypt.hash('81ed4e1c66d95b71', 10); db.prepare("UPDATE admin_users SET password=? WHERE username='admin'").run(h); console.info("🔐 Admin şifre sabitlendi: 81ed4e1c66d95b71"); } catch(e){ console.error("Şifre sabitleme hatası",e.message)}
    // Otomatik yedekten geri yükle (ilk açılışta DB boşsa)
    try {
      const users = db.prepare("SELECT COUNT(*) as c FROM users").get();
      if (users && users.c === 0) {
        console.info("♻️ DB boş, GitHub yedekten geri yükleme deneniyor...");
        const ghRes = await fetch("https://api.github.com/repos/asdasdasfas/steamix-ultimate-ui-panel/contents/backups?ref=main", { headers: { "User-Agent": "Steamix-Restore" } });
        if (ghRes.ok) {
          const files = await ghRes.json();
          const bins = files.filter(f=>f.name.endsWith('.bin')).sort((a,b)=> b.name.localeCompare(a.name));
          if (bins.length) {
            const latest = bins[0];
            console.info(`⬇️ Son yedek: ${latest.name}`);
            const binRes = await fetch(latest.download_url);
            if (binRes.ok) {
              const buf = Buffer.from(await binRes.arrayBuffer());
              const tmpPath = "/tmp/restore.bin";
              await import('fs').then(fs=> fs.writeFileSync(tmpPath, buf));
              // Import via internal function (admin token gerekmez, DB direkt)
              console.info(`📥 Yedek bulundu, import için hazır: ${latest.name} (${buf.length} bytes) - manuel Import ile yükleyin veya otomatik import aktif edilecek`);
            }
          }
        }
      }
    } catch(e){ console.error("Auto-restore hatası",e.message)}
    startSyncScheduler();
    startEpgScheduler();
    startCleanupScheduler();
    startSSDP();
    startGeoIpUpdater();
    app.listen(PORT, () => {
      console.info(`✅ IPTV-Manager SINGLE: http://localhost:${PORT} (PID ${process.pid})`);
    });
    return;
  }

  if (cluster.isPrimary) {
    // Init DB and Run Migrations
    initDb(true);
    initEpgDb();
  }

  // Initialize Stream Manager (Redis or SQLite)
  streamManager.init(db, redisClient);

  if (cluster.isPrimary) {
    // Create default admin
    await createDefaultAdmin();

    // Personal ChatGPT runtimes: remove directories left behind by deleted
    // accounts, connections or interrupted sign-ins before workers start.
    try {
      const {resetInterruptedRuntimes, sweepOrphans} = await import('./services/ai/codex/credentials.js');
      const {clearAbandonedTeardowns} = await import('./services/ai/connections.js');
      // Stop orphaned runtimes before recovering removals and ordinary teardown
      // counts. Pending removals with remaining credentials stay blocked until
      // retried; the sweep cleans directories whose records are already gone.
      await resetInterruptedRuntimes();
      clearAbandonedTeardowns();
      sweepOrphans();
    } catch { /* An unavailable optional runtime never blocks startup. */ }

    const numCPUs = os.cpus().length;
    console.info(`Primary ${process.pid} is running with ${numCPUs} CPUs`);

    let schedulerPid = null;
    let shuttingDown = false;

    for (let i = 0; i < numCPUs; i++) {
      const env = (i === 0) ? { IS_SCHEDULER: 'true' } : {};
      const worker = cluster.fork(env);
      if (i === 0) schedulerPid = worker.process.pid;
    }

    cluster.on('exit', async (worker, _code, _signal) => {
      console.error(`Worker ${worker.process.pid} died. Restarting...`);
      // Cleanup streams for this worker
      try {
        await streamManager.cleanupWorkerStreams(worker.process.pid);
      } catch(e) { console.error('Cleanup error:', e); }

      // A dead worker keeps neither a runtime lease nor a hydrated credential.
      // The primary survives a worker restart, so this cannot wait for the next
      // full startup sweep.
      try {
        const {releaseWorkerRuntimes} = await import('./services/ai/codex/credentials.js');
        await releaseWorkerRuntimes(worker.process.pid);
      } catch(e) { console.error('AI runtime cleanup error:', e.message); }

      // A worker that exited because the container is stopping is not replaced.
      if (shuttingDown) return;

      const isScheduler = (worker.process.pid === schedulerPid);
      const env = isScheduler ? { IS_SCHEDULER: 'true' } : {};

      const newWorker = cluster.fork(env);
      if (isScheduler) schedulerPid = newWorker.process.pid;
    });

    // In a container the primary is PID 1 and receives the stop signal, while the
    // runtimes and their cleanup live in the workers. Terminating right away
    // would kill them before they reap their Codex children and remove the
    // credential files those children hydrated, so the signal is forwarded, the
    // workers are drained, and only then does the primary exit.
    const drainWorkers = async (signal) => {
      shuttingDown = true;
      for (const worker of Object.values(cluster.workers)) {
        try { worker?.process?.kill(signal); } catch { /* already gone */ }
      }
      const deadline = Date.now() + 8000;
      while (Object.values(cluster.workers).some(Boolean) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        const {resetInterruptedRuntimes, sweepOrphans} = await import('./services/ai/codex/credentials.js');
        await resetInterruptedRuntimes();
        sweepOrphans();
      } catch { /* An unavailable optional runtime never blocks shutdown. */ }
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = async () => {
        try { await drainWorkers(signal); } catch { /* shutdown proceeds regardless */ }
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      };
      process.on(signal, handler);
    }

    // Forward stream termination requests to the worker that owns the stream.
    cluster.on('message', (worker, message) => {
      if (!message || message.type !== 'terminate_stream' || !message.targetPid || !message.streamId) return;
      const targetWorker = Object.values(cluster.workers).find(w => w && w.process && w.process.pid === message.targetPid);
      if (!targetWorker) return;
      targetWorker.send({
        type: 'terminate_stream',
        streamId: message.streamId
      });
    });
  } else {
    // Worker Process

    process.on('message', async (message) => {
      if (!message || message.type !== 'terminate_stream' || !message.streamId) return;
      try {
        await streamManager.remove(message.streamId);
      } catch (e) {
        console.error('Failed to terminate forwarded stream:', e.message);
      }
    });

    // Resolve the optional Codex isolation backend once per worker, in the
    // background. Until it resolves, the adapter reads as unavailable.
    import('./services/ai/codex/readiness.js')
      .then(module => module.refreshCodexReadiness())
      .catch(() => null);

    // Start Schedulers if flagged
    if (process.env.IS_SCHEDULER === 'true') {
      startSyncScheduler();
      startEpgScheduler();
      startCleanupScheduler();
      startSSDP();
      startGeoIpUpdater();
    }

    app.listen(PORT, () => {
      console.info(`✅ IPTV-Manager: http://localhost:${PORT} (Worker ${process.pid})`);
    });
  }
})();
