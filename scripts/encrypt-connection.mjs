#!/usr/bin/env node
import { scryptSync, createCipheriv, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, '.deploy-state');
const CONN_FILE = join(STATE, 'connection.json');
const ENC_FILE = join(__dirname, 'connection.enc');

const SECRET = process.env.DEPLOY_SECRET;
if (!SECRET) {
  console.error('❌ DEPLOY_SECRET environment variable is not set.');
  console.error('   Set it first:  $env:DEPLOY_SECRET = "your-secret-phrase"');
  process.exit(1);
}
if (!existsSync(CONN_FILE)) {
  console.error(`❌ ${CONN_FILE} not found. Run deploy first to create it.`);
  process.exit(1);
}

const conn = JSON.parse(readFileSync(CONN_FILE, 'utf-8'));

// Derive 32-byte key from DEPLOY_SECRET using scrypt
const key = scryptSync(SECRET, 'athena-deploy-salt-2026', 32);
const iv = randomBytes(16);
const cipher = createCipheriv('aes-256-gcm', key, iv);
let enc = cipher.update(JSON.stringify(conn), 'utf-8', 'hex');
enc += cipher.final('hex');
const tag = cipher.getAuthTag().toString('hex');

// Format: iv:tag:ciphertext (all hex)
const output = `${iv.toString('hex')}:${tag}:${enc}`;
writeFileSync(ENC_FILE, output, 'utf-8');
console.log(`✅ Encrypted connection saved to ${ENC_FILE}`);
console.log('   Commit this file: git add scripts/connection.enc');
