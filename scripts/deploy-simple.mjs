#!/usr/bin/env node

import { createHash } from 'crypto';
import { existsSync, mkdirSync, cpSync, readFileSync, readdirSync, statSync, writeFileSync, createReadStream } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, relative } from 'path';
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { fileURLToPath } from 'url';
import { Client } from 'ssh2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, '.deploy-state');
const ROOT = join(__dirname, '..');
const CONN_FILE = join(STATE, 'connection.json');
const MANIFEST_FILE = join(STATE, 'manifest.json');

const SOURCES = [
  { dir: 'server/dist' },
  { file: 'server/package.json' },
  { file: 'server/package-lock.json' },
  { dir: 'smart-routing-core/dist' },
  { file: 'smart-routing-core/package.json' },
];

// ─── Interactive input ─────────────────────────────────────────
const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q, def) => {
  const d = def ? ` [${def}]` : '';
  const a = await rl.question(`${q}${d}: `);
  return a.trim() || def || '';
};

// ─── Helpers ───────────────────────────────────────────────────
function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } }
function writeJSON(p, d) {
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(d, null, 2));
}
function sha256(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

function walkDir(abs) {
  if (!existsSync(abs)) return [];
  const out = [];
  const w = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? w(p) : out.push(p); } };
  w(abs);
  return out;
}

function buildManifest() {
  const m = {};
  for (const s of SOURCES) {
    if (s.dir) for (const f of walkDir(join(ROOT, s.dir))) m[relative(ROOT, f).replace(/\\/g, '/')] = sha256(f);
    if (s.file) { const fp = join(ROOT, s.file); if (existsSync(fp)) m[s.file.replace(/\\/g, '/')] = sha256(fp); }
  }
  return m;
}

function diffManifest(prev, cur) {
  const changed = [], added = [], deleted = [];
  for (const [k, h] of Object.entries(cur)) { if (!prev[k]) added.push(k); else if (prev[k] !== h) changed.push(k); }
  for (const k of Object.keys(prev || {})) { if (!cur[k]) deleted.push(k); }
  return { changed, added, deleted };
}

// ─── SSH2 ──────────────────────────────────────────────────────
function connect(cfg) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const opts = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.user,
      readyTimeout: 20000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      hostVerifier: () => true,
    };

    if (cfg.authType === 'key') {
      opts.privateKey = readFileSync(cfg.keyPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE), 'utf-8');
      if (cfg.passphrase) opts.passphrase = cfg.passphrase;
    } else {
      opts.password = cfg.pw;
      opts.tryKeyboard = true;
    }

    client.on('ready', () => resolve(client));
    client.on('error', reject);
    client.on('keyboard-interactive', (_n, _i, _l, _p, next) => next([cfg.pw || '']));
    client.connect(opts);
  });
}

function exec(client, cmd) {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(new Error(err.message));
      let out = '', errOut = '';
      stream.on('close', (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(errOut.trim() || out.trim() || `exit code ${code}`));
      });
      stream.on('data', (d) => out += d.toString());
      stream.stderr.on('data', (d) => errOut += d.toString());
    });
  });
}

async function ensureRemoteDir(client, abs) {
  try {
    await exec(client, `mkdir -p "${abs}"`);
  } catch {}
}

async function uploadFile(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(new Error(err.message));
      const stream = sftp.createWriteStream(remotePath, { mode: 0o644 });
      stream.on('close', () => { sftp.end(); resolve(); });
      stream.on('error', (e) => { sftp.end(); reject(e); });
      createReadStream(localPath).pipe(stream);
    });
  });
}

// ───────────────────────────────────────────────────────────────
async function main() {
  // ─── Connection info ──────────────────────────────────────
  let cache = readJSON(CONN_FILE);
  let conn;

  if (cache) {
    const ok = await ask(`Kullan: ${cache.user}@${cache.host}`, 'Y');
    if (ok.toLowerCase() === 'y' || ok === '') conn = cache;
  }

  if (!conn) {
    conn = {};
    conn.user = await ask('SSH kullanıcısı', 'root');
    conn.host = await ask('Sunucu IP/host');
    const auth = await ask('Auth (1=key, 2=password)', '1');
    if (auth === '2') {
      conn.authType = 'password';
      conn.pw = await rl.question('SSH şifresi: ');
      conn.port = parseInt(await ask('Port', '22'), 10);
    } else {
      conn.authType = 'key';
      conn.keyPath = (await ask('SSH key yolu', '~/.ssh/id_rsa')).replace(/^~/, process.env.HOME || process.env.USERPROFILE);
      const pp = await ask('Passphrase (boş geç)', '');
      if (pp) conn.passphrase = pp;
      conn.port = parseInt(await ask('Port', '22'), 10);
    }

    // Test connection
    console.log('  🔌 Bağlantı test ediliyor...');
    let client;
    try {
      client = await connect(conn);
      const home = await exec(client, 'echo ~');
      console.log(`  ✅ Connectivity OK, home=${home}`);
      conn.remoteBase = (await ask('Hedef dizin', `${home}/athena`));
    } catch (e) {
      console.log(`  ⚠️  Test failed: ${e.message}`);
      conn.remoteBase = await ask('Hedef dizin');
    } finally {
      if (client) client.end();
    }

    writeJSON(CONN_FILE, { ...conn });
  } else if (conn.authType === 'password') {
    conn.pw = await rl.question('SSH şifresi: ');
  }

  rl.close();

  const remoteBase = conn.remoteBase;

  // ─── [1] Build ────────────────────────────────────────────
  console.log('\n\x1b[36m[1/4] Building...\x1b[0m');

  const runBuild = (dir, label) => {
    console.log(`  🔨 ${label}`);
    execSync('npm install --no-fund --no-audit && npm run build', { cwd: dir, stdio: 'inherit' });
  };
  runBuild(ROOT, 'frontend');
  runBuild(join(ROOT, 'smart-routing-core'), 'smart-routing-core');
  runBuild(join(ROOT, 'server'), 'server');

  // Copy frontend build into the server's public directory so the backend
  // can serve static files (server/src/index.ts → express.static('public')).
  const frontendDist = join(ROOT, 'dist');
  const serverPublic = join(ROOT, 'server', 'dist', 'public');
  if (existsSync(frontendDist)) {
    if (!existsSync(serverPublic)) mkdirSync(serverPublic, { recursive: true });
    cpSync(frontendDist, serverPublic, { recursive: true, force: true });
    // Remote config.json: empty apiUrl means same-origin (frontend & backend on one port)
    writeJSON(join(serverPublic, 'config.json'), { apiUrl: '' });
  }

  // ─── [2] Diff & upload ────────────────────────────────────
  console.log('\n\x1b[36m[2/4] Syncing files...\x1b[0m');
  const client = await connect(conn);

  try {
    let prev = readJSON(MANIFEST_FILE) || {};
    let cur = buildManifest();
    let { changed, added, deleted } = diffManifest(prev, cur);
    let all = [...changed, ...added];

    if (!all.length && !deleted.length) {
      console.log('  ✅ No files changed.');
    } else {
      if (all.length) console.log(`  📤 ${all.length} files to upload`);
      if (deleted.length) console.log(`  🗑️  ${deleted.length} files to remove`);

      const dirs = new Set(['server/data']);
      for (const f of all) {
        const d = dirname(f).replace(/\\/g, '/');
        if (d !== '.') dirs.add(d);
      }
      for (const d of dirs) await ensureRemoteDir(client, `${remoteBase}/${d}`);

      for (const f of deleted) {
        try { await exec(client, `rm -f "${remoteBase}/${f}"`); } catch {}
      }

      for (let i = 0; i < all.length; i++) {
        const rel = all[i];
        const lp = join(ROOT, rel);
        if (!existsSync(lp)) continue;
        const bytes = statSync(lp).size;
        const label = bytes > 1024 ? `${(bytes / 1024).toFixed(0)}KB` : `${bytes}B`;
        process.stdout.write(`  [${i + 1}/${all.length}] ${rel} (${label})\n`);
        await uploadFile(client, lp, `${remoteBase}/${rel}`);
      }
    }

    // ─── [3] Remote setup ───────────────────────────────────
    console.log('\n\x1b[36m[3/4] Remote setup...\x1b[0m');

    const pkgChanged = [...changed, ...added].some(f => f.startsWith('server/package'));
    const firstTime = !prev || !Object.keys(prev).length;

    if (firstTime || pkgChanged) {
      console.log('  📦 npm install --production');
      await exec(client, `cd "${remoteBase}/server" && npm install --production --no-fund --no-audit`);
    } else {
      console.log('  📦 No package.json changes, skipping npm install.');
    }

    let sudoPre = '';
    try {
      await exec(client, 'id -u');
      const uid = (await exec(client, 'id -u')).trim();
      if (uid !== '0') sudoPre = 'sudo ';
    } catch {}

    try {
      await exec(client, `${sudoPre}which pm2 2>/dev/null || command -v pm2 2>/dev/null || which pm2`);
      console.log('  ✅ PM2 already installed.');
    } catch {
      console.log('  ⚙️  Installing PM2...');
      await exec(client, `${sudoPre}npm install -g pm2`);
      await exec(client, `${sudoPre}env PATH=$PATH pm2 startup systemd -u ${conn.user} --hp /home/${conn.user}`);
    }

    const exists = await exec(client, `pm2 describe athena-server 2>/dev/null; echo "EXIT:$?"`).then(r => !r.includes('EXIT:1')).catch(() => false);
    if (exists) {
      console.log('  🔄 Restarting athena-server...');
      await exec(client, `cd "${remoteBase}/server" && pm2 restart athena-server --update-env`);
    } else {
      console.log('  🚀 Starting athena-server...');
      await exec(client, `cd "${remoteBase}/server" && pm2 start dist/index.js --name athena-server --update-env`);
    }
    await exec(client, 'pm2 save');

    await new Promise(r => setTimeout(r, 2000));
    const health = await exec(client, `curl -s --max-time 5 http://localhost:${process.env.PORT || 3001}/health || echo "FAIL"`);
    if (health === 'FAIL') {
      console.log(`  ⚠️  Health check failed, but service may still be starting up.`);
    } else {
      console.log(`  ❤️  Health OK: ${health}`);
    }

    // Diagnostics & firewall
    console.log('\n\x1b[36m[Network check]\x1b[0m');
    try {
      const listen = await exec(client, `ss -tlnp | grep 3001 || true`);
      console.log(`  🔌 Listen: ${listen || '(no match)'}`);
    } catch {}

    let accessHost = conn.host;
    try {
      const ts = (await exec(client, 'tailscale ip -4 2>/dev/null')).trim().split('\n')[0];
      if (ts) {
        accessHost = ts;
        try {
          const tsHealth = await exec(client, `curl -s --max-time 5 http://${ts}:3001/health || echo "FAIL"`);
          console.log(`  ❤️  Tailscale health: ${tsHealth}`);
        } catch {}
        try {
          const iface = (await exec(client, `ip -o link show | awk -F': ' '/tailscale/ {print $2}' | head -n1`)).trim();
          if (iface) {
            console.log(`  🛡️  Tailscale interface: ${iface}`);
            try {
              await exec(client, `${sudoPre}iptables -C INPUT -i ${iface} -p tcp --dport 3001 -j ACCEPT 2>/dev/null || ${sudoPre}iptables -I INPUT -i ${iface} -p tcp --dport 3001 -j ACCEPT`);
              console.log(`  ✅ Port 3001 opened on ${iface}`);
            } catch (e) {
              console.log(`  ⚠️  Could not open port 3001 on ${iface}: ${e.message}`);
            }
          }
        } catch {}
      }
    } catch {}

    writeJSON(MANIFEST_FILE, cur);
    writeJSON(join(ROOT, 'public/config.json'), { apiUrl: `http://${accessHost}:${process.env.PORT || 3001}` });
    // ─── [4] Done ───────────────────────────────────────────
    console.log('\n\x1b[36m[4/4] Done.\x1b[0m');

    console.log('\n\x1b[32m✅ Deploy complete!\x1b[0m');
    console.log(`   📋 Logs:   ssh ${conn.user}@${conn.host} "pm2 logs athena-server"`);
    console.log(`   ❤️  Health: http://${accessHost}:3001/health`);

  } finally {
    client.end();
  }
}

main().catch(e => {
  console.error(`\n\x1b[31m❌ ${e.message || e}\x1b[0m`);
  process.exit(1);
});
