#!/usr/bin/env node
import { readFileSync, createReadStream, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { Client } from 'ssh2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, '.deploy-state');
const CONN_FILE = join(STATE, 'connection.json');
const LOCAL_SETTINGS = join(__dirname, '..', 'server', 'data', 'settings.json');
const rl = createInterface({ input: stdin, output: stdout });

if (!existsSync(CONN_FILE)) { console.error('❌ No deploy state. Run deploy first.'); process.exit(1); }
if (!existsSync(LOCAL_SETTINGS)) { console.error('❌ Local settings.json not found.'); process.exit(1); }

const conn = JSON.parse(readFileSync(CONN_FILE, 'utf-8'));
const settings = JSON.parse(readFileSync(LOCAL_SETTINGS, 'utf-8'));

async function main() {
  if (conn.authType === 'password') conn.pw = await rl.question('SSH şifresi: ');
  rl.close();

  const client = await new Promise((resolve, reject) => {
    const c = new Client();
    const opts = {
      host: conn.host, port: conn.port || 22, username: conn.user,
      readyTimeout: 20000, hostVerifier: () => true,
    };
    if (conn.authType === 'key') opts.privateKey = readFileSync(conn.keyPath, 'utf-8');
    else { opts.password = conn.pw; opts.tryKeyboard = true; }
    if (conn.passphrase) opts.passphrase = conn.passphrase;
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    c.on('keyboard-interactive', (_n, _i, _l, _p, next) => next([conn.pw || '']));
    c.connect(opts);
  });

  try {
    // Upload settings.json
    const remotePath = `${conn.remoteBase}/server/data/settings.json`;
    await new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createWriteStream(remotePath, { mode: 0o644 });
        stream.on('close', resolve);
        stream.on('error', reject);
        createReadStream(LOCAL_SETTINGS).pipe(stream);
      });
    });
    console.log('  ✅ settings.json uploaded');

    // Restart
    await new Promise((resolve, reject) => {
      client.exec('pm2 restart athena-server --update-env', (e, s) => {
        if (e) return reject(e);
        let o = '';
        s.on('data', d => o += d);
        s.stderr.on('data', d => o += d);
        s.on('close', (code) => { if (code === 0) resolve(o); else reject(new Error(o)); });
      });
    });
    console.log('  ✅ Server restarted');

    // Health check
    await new Promise(r => setTimeout(r, 2000));
    client.exec('curl -s --max-time 5 http://localhost:3001/health', (e, s) => {
      let o = '';
      s.on('data', d => o += d);
      s.on('close', () => console.log('  ❤️  Health:', o.trim()));
      client.end();
    });
  } catch (e) {
    console.error('  ❌', e.message);
    client.end();
  }
}

main();
