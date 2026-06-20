import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeployEngine } from './lib/engine.mjs';
import { loadConfig, saveConfig } from './lib/utils.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.DEPLOY_PORT || 4000;
const CONFIG_PATH = join(DIR, 'deploy.json');
const SSH = 'ssh';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

let jobCounter = 0;
const jobs = new Map();

function createJob(type) {
  const id = ++jobCounter;
  const job = { id, type, events: [], done: false, error: null };
  jobs.set(id, job);
  return job;
}

function pushEvent(job, data) {
  job.events.push(data);
  for (const cb of (job._listeners || [])) { try { cb(data); } catch {} }
}

function onEvent(job, cb) {
  if (!job._listeners) job._listeners = [];
  job._listeners.push(cb);
  return () => { job._listeners = job._listeners.filter(l => l !== cb); };
}

function send(res, code, data, type) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}

function serveFile(res, path) {
  try { send(res, 200, readFileSync(path, 'utf-8'), MIME[extname(path).toLowerCase()] || 'text/plain; charset=utf-8'); }
  catch { send(res, 404, 'Not Found'); }
}

function getConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch { return null; }
}

function hasTarget() {
  const cfg = getConfig();
  return cfg && cfg.host && cfg.host !== '';
}

function getEngine() {
  const cfg = getConfig();
  return cfg ? new DeployEngine(cfg) : null;
}

async function runWithSSE(job, engine, operationFn) {
  try {
    await operationFn((msg, type = 'log') => pushEvent(job, { type, message: msg }));
    pushEvent(job, { type: 'done' });
  } catch (err) {
    pushEvent(job, { type: 'error', message: err.message });
  } finally {
    job.done = true;
  }
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // ── SSE job events ──
  if (p.startsWith('/api/events/')) {
    const jobId = parseInt(p.split('/').pop(), 10);
    const job = jobs.get(jobId);
    if (!job) return send(res, 404, 'Job not found');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (job.done) return res.end();

    const unsub = onEvent(job, (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} });
    req.on('close', () => { unsub(); });
    return;
  }

  // ── GET /api/status ──
  if (p === '/api/status') {
    const target = hasTarget();
    if (!target) return send(res, 200, { target: false });
    const engine = getEngine();
    engine.testConnection().then(connected => {
      if (!connected) return send(res, 200, { target: true, connected: false });
      Promise.all([
        engine.gatherRemoteInfo().catch(() => ({})),
        engine.healthCheck().catch(() => ({ ok: false })),
      ]).then(([info, hc]) => {
        send(res, 200, { target: true, connected: true, info, running: hc.ok });
      });
    }).catch(() => send(res, 200, { target: true, connected: false }));
    return;
  }

  // ── GET /api/ping ──
  if (p === '/api/ping') {
    // Read raw file content for debugging
    let rawContent = null;
    try { rawContent = readFileSync(CONFIG_PATH, 'utf-8'); } catch {}
    const cfg = getConfig();
    if (!cfg) return send(res, 200, { ok: false, error: 'config file not found or invalid JSON', cfg, rawContent });
    const engine = new DeployEngine(cfg);
    const host = engine.host;
    if (!host) return send(res, 200, { ok: false, error: 'host is empty', cfg, rawContent });
    const args = [...engine.sshArgs(), host, 'echo ok'];
    let errMsg = '';
    const child = spawn(SSH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', d => { errMsg += d.toString(); });
    child.on('close', (code) => {
      send(res, 200, { ok: code === 0, error: code !== 0 ? (errMsg || 'exit code ' + code) : undefined, cfg, rawContent, args });
    });
    child.on('error', (e) => {
      send(res, 200, { ok: false, error: 'spawn error: ' + e.message, cfg, rawContent });
    });
    return;
  }

  // ── GET /api/info ──
  if (p === '/api/info') {
    const engine = getEngine();
    if (!engine) return send(res, 200, {});
    engine.gatherRemoteInfo().then(info => send(res, 200, info)).catch(() => send(res, 200, {}));
    return;
  }

  // ── GET /api/health ──
  if (p === '/api/health') {
    const engine = getEngine();
    if (!engine) return send(res, 200, { ok: false });
    engine.healthCheck().then(h => send(res, 200, h)).catch(() => send(res, 200, { ok: false }));
    return;
  }

  // ── POST /api/init | /api/deploy | /api/uninstall ──
  if ((p === '/api/init' || p === '/api/deploy' || p === '/api/uninstall') && req.method === 'POST') {
    const engine = getEngine();
    if (!engine) return send(res, 400, { error: 'No config' });
    const job = createJob(p);
    send(res, 200, { jobId: job.id });

    if (p === '/api/init') {
      runWithSSE(job, engine, async (emit) => {
        emit('Connecting...');
        if (!(await engine.testConnection())) return void emit('SSH connection failed', 'error');
        emit('Connected');
        emit('Creating directories...');
        await engine.ensureDirs();
        emit('Setting up Node.js...');
        const nr = await engine.setupNode(engine.config.nodeVersion || 20);
        emit(nr.upgraded ? `Node.js ${nr.version} installed` : `Node.js ${nr.version} ready`);
        emit('Setting up PM2...');
        const pr = await engine.setupPM2();
        emit(pr.installed ? `PM2 ${pr.version} installed` : `PM2 ${pr.version} ready`);
        emit('Init complete');
      });
    } else if (p === '/api/deploy') {
      runWithSSE(job, engine, async (emit) => {
        emit('Connecting...');
        if (!(await engine.testConnection())) return void emit('SSH connection failed', 'error');
        emit('Connected');

        const projectDir = resolve(DIR, '..');
        emit('Creating manifest...');
        const localManifest = engine.createManifest(projectDir);
        const nFiles = Object.keys(localManifest.files).length;
        emit(`Local: ${nFiles} files`);

        const remoteManifest = await engine.fetchRemoteManifest();
        const changed = engine.compareManifests(localManifest, remoteManifest);
        emit(`${changed.length} files changed`);

        await engine.ensureDirs();
        const version = `v${Date.now()}`;
        const releaseDir = `${engine.remotePath}/releases/${version}`;
        await engine.ssh('', `mkdir -p "${releaseDir}"`);

        if (changed.length > 0) {
          emit(`Syncing ${changed.length} files...`);
          const tmp = resolve(process.env.TEMP || '/tmp', `deploy-files-${Date.now()}.txt`);
          writeFileSync(tmp, changed.join('\n'));
          const tar = spawn('tar', ['czf', '-', '--no-recursion', '--files-from', tmp], { cwd: projectDir });
          const sshArgs = [...engine.sshArgs(), engine.host, `cd "${releaseDir}" && tar xzf -`];
          const ssh = spawn('ssh', sshArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
          await new Promise((resolve, reject) => {
            tar.stdout.pipe(ssh.stdin);
            ssh.on('close', resolve);
            ssh.on('error', reject);
          });
          try { execSync(`rm "${tmp}" 2>/dev/null || del "${tmp}" 2>nul`); } catch {}
        }

        emit('Building on remote...');
        const buildCmd = `cd "${releaseDir}" && cd smart-routing-core && npm install && npm run build && cd ../server && npm install && npm run build && cd .. && npm install && npm run build`;
        await engine.sshStream('', buildCmd, (d) => emit(d));

        emit('Swapping release...');
        await engine.swapRelease(version);

        emit('Reloading service...');
        await engine.reloadService();

        emit('Health check...');
        const hc = await engine.healthCheck();
        emit(hc.ok ? 'Service is running' : 'Health check failed', hc.ok ? 'done' : 'error');

        await engine.uploadManifest(localManifest);
        emit('Deploy complete');
      });
    } else {
      runWithSSE(job, engine, async (emit) => {
        emit('Stopping service...');
        await engine.ssh('', `pm2 delete athena 2>/dev/null; pm2 save 2>/dev/null; true`);
        emit('Removing files...');
        await engine.ssh('', `rm -rf ${engine.remotePath}`);
        emit('Uninstall complete');
      });
    }
    return;
  }

  // ── POST /api/rollback ──
  if (p === '/api/rollback' && req.method === 'POST') {
    const engine = getEngine();
    if (!engine) return send(res, 200, { ok: false });
    const steps = parseInt(url.searchParams.get('steps') || '1', 10);
    engine.rollback(steps).then(r => send(res, 200, r)).catch(e => send(res, 200, { ok: false, error: e.message }));
    return;
  }

  // ── GET /api/logs ──
  if (p === '/api/logs') {
    const engine = getEngine();
    if (!engine) return send(res, 200, { logs: 'No target configured' });
    const lines = parseInt(url.searchParams.get('lines') || '50', 10);
    engine.ssh('', `pm2 logs athena --lines ${lines} --nostream 2>&1 || journalctl -u athena -n ${lines} --no-pager 2>&1 || echo "No logs"`)
      .then(out => send(res, 200, { logs: out, lines }))
      .catch(() => send(res, 200, { logs: 'No logs available', lines }));
    return;
  }

  // ── GET /api/releases ──
  if (p === '/api/releases') {
    const engine = getEngine();
    if (!engine) return send(res, 200, []);
    (async () => {
      try {
        const out = await engine.ssh('', `ls -1d ${engine.remotePath}/releases/*/ 2>/dev/null || true`);
        const dirs = out.trim().split('\n').filter(Boolean).reverse();
        const releases = [];
        for (const d of dirs) {
          const ver = d.split('/').filter(Boolean).pop() || '?';
          const meta = await engine.ssh('', `cat ${d}deploy-meta.json 2>/dev/null || echo "{}"`).catch(() => '{}');
          const st = await engine.ssh('', `stat -c '%Y' ${d} 2>/dev/null || echo "0"`).catch(() => '0');
          try { releases.push({ version: ver, timestamp: new Date(parseInt(st) * 1000).toISOString(), ...JSON.parse(meta) }); }
          catch { releases.push({ version: ver, timestamp: new Date().toISOString() }); }
        }
        send(res, 200, releases);
      } catch { send(res, 200, []); }
    })();
    return;
  }

  // ── PUT /api/config ──
  if (p === '/api/config' && req.method === 'PUT') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        saveConfig(parsed);
        send(res, 200, { ok: true, receivedHost: parsed.host });
      }
      catch (e) { send(res, 400, { ok: false, error: e.message, body }); }
    });
    return;
  }

  // ── GET /api/config ──
  if (p === '/api/config') {
    return send(res, 200, getConfig() || {});
  }

  // ── Static files ──
  if (p === '/' || p === '/index.html') return serveFile(res, join(DIR, 'dashboard.html'));
  let filePath = join(DIR, p);
  if (!existsSync(filePath)) filePath = join(DIR, p + '.html');
  if (existsSync(filePath)) return serveFile(res, filePath);

  send(res, 404, 'Not Found');
}).listen(PORT, () => {
  console.log(`  ATHENA Deploy \u2192 http://localhost:${PORT}`);
});
