#!/usr/bin/env node
/**
 * Publica el dashboard en GitHub (main) para que Netlify despliegue al hacer push.
 *
 * Repo por defecto: Criscode2022/als-cron-dashboard
 * Flujo:
 *   1. npm run sync  (snapshot fresco desde monorepo)
 *   2. Empaqueta app (public + scripts + package.json + netlify.toml)
 *   3. git push force a main del repo de despliegue
 *
 * Netlify debe estar vinculado a ese repo (branch main, publish public, build npm run build).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.resolve(__dirname, '..');
const REPO = process.env.ALS_DASH_REPO || 'Criscode2022/als-cron-dashboard';
const BRANCH = process.env.ALS_DASH_BRANCH || 'main';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status || 1);
}

console.log('→ sync snapshot from monorepo');
run(process.execPath, [path.join(__dirname, 'sync-data.mjs')], { cwd: DASH });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'als-dash-pub-'));
console.log('→ stage', tmp);

// Files needed on Netlify / GitHub main (Neon is source of truth at runtime)
const copies = [
  ['public', 'public'],
  ['scripts/lib', 'scripts/lib'],
  ['scripts/sync-data.mjs', 'scripts/sync-data.mjs'],
  ['scripts/apply-memory-edits.mjs', 'scripts/apply-memory-edits.mjs'],
  // apply-memory-edits is imported by db.mjs for Neon memory dual-write
  ['scripts/server.mjs', 'scripts/server.mjs'],
  ['scripts/watch-sync.mjs', 'scripts/watch-sync.mjs'],
  ['scripts/publish-github.mjs', 'scripts/publish-github.mjs'],
  ['netlify/functions', 'netlify/functions'],
  // function is self-contained (only needs @neondatabase/serverless from package.json)
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['netlify.toml', 'netlify.toml'],
  ['README.md', 'README.md'],
  ['NETLIFY-SETUP.md', 'NETLIFY-SETUP.md'],
  ['.env.example', '.env.example'],
  ['.gitignore', '.gitignore'],
];

for (const [from, to] of copies) {
  const src = path.join(DASH, from);
  if (!fs.existsSync(src)) {
    console.warn('skip missing', from);
    continue;
  }
  const dest = path.join(tmp, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// Netlify: validate snapshot fallback + install neon driver for functions
const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
pkg.scripts = {
  ...pkg.scripts,
  // Snapshot fallback for static CDN; runtime data comes from Neon via /api/*
  build:
    "node -e \"const fs=require('fs');const p='public/data/snapshot.json';if(!fs.existsSync(p))process.exit(1);console.log('snapshot ok',fs.statSync(p).size);console.log('set DATABASE_URL for Neon API')\"",
};
// Ensure serverless driver is present for netlify/functions
if (!pkg.dependencies) pkg.dependencies = {};
if (!pkg.dependencies['@neondatabase/serverless']) {
  pkg.dependencies['@neondatabase/serverless'] = '^1.1.0';
}
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// README deploy note
const readme = fs.readFileSync(path.join(tmp, 'README.md'), 'utf8');
if (!readme.includes('Netlify')) {
  /* keep as is */
}

fs.writeFileSync(path.join(tmp, 'public/.nojekyll'), '');

run('git', ['init'], { cwd: tmp });
run('git', ['checkout', '-B', BRANCH], { cwd: tmp });
run('git', ['-c', 'user.email=cron@ux-projects.local', '-c', 'user.name=UX Cron', 'add', '-A'], {
  cwd: tmp,
});
run(
  'git',
  [
    '-c',
    'user.email=cron@ux-projects.local',
    '-c',
    'user.name=UX Cron',
    'commit',
    '-m',
    `deploy: ALS dashboard ${new Date().toISOString().slice(0, 19)}`,
  ],
  { cwd: tmp },
);

// Prefer SSH if origin style used before; gh uses https with token
const remote = `https://github.com/${REPO}.git`;
run('git', ['remote', 'add', 'origin', remote], { cwd: tmp });
console.log(`→ push ${REPO} ${BRANCH}`);
run('git', ['push', '-u', 'origin', BRANCH, '--force'], { cwd: tmp });

console.log(`
OK — GitHub actualizado: https://github.com/${REPO}
Netlify (si el site está vinculado a main): deploy automático en curso.
Local write-back: cd monorepo/dashboard && npm start → http://127.0.0.1:4177
`);
