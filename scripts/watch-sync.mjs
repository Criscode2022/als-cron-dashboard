#!/usr/bin/env node
/**
 * Observa memory, registry, CRON, LEARNING y cases; re-ejecuta sync-data.
 * Uso: node scripts/watch-sync.mjs
 * Opcional: ALS_WATCH_DEBOUNCE_MS=400
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.resolve(__dirname, '..');
const ROOT = path.resolve(DASH, '..');
const DEBOUNCE = Number(process.env.ALS_WATCH_DEBOUNCE_MS || 500);

function sync(reason) {
  console.log(`[watch] sync ← ${reason}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'sync-data.mjs')], {
    encoding: 'utf8',
    cwd: DASH,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) console.error('[watch] sync failed');
}

let timer = null;
function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => sync(reason), DEBOUNCE);
}

function watchFile(file, label) {
  if (!fs.existsSync(file)) return;
  try {
    fs.watch(file, { persistent: true }, () => schedule(label));
    console.log(`[watch] file ${path.relative(ROOT, file)}`);
  } catch (e) {
    console.warn(`[watch] cannot watch ${file}:`, e.message);
  }
}

function watchDir(dir, label, filter) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.watch(dir, { recursive: true, persistent: true }, (_ev, filename) => {
      if (!filename) return schedule(label);
      if (filter && !filter(filename)) return;
      schedule(`${label}:${filename}`);
    });
    console.log(`[watch] dir  ${path.relative(ROOT, dir)}${filter ? ' (filtered)' : ''}`);
  } catch (e) {
    // recursive may fail on some systems — fall back non-recursive
    try {
      fs.watch(dir, { persistent: true }, () => schedule(label));
      console.log(`[watch] dir  ${path.relative(ROOT, dir)} (non-recursive)`);
    } catch (e2) {
      console.warn(`[watch] cannot watch ${dir}:`, e2.message);
    }
  }
}

console.log(`[watch] root ${ROOT}`);
sync('startup');

watchFile(path.join(ROOT, 'memory.md'), 'memory.md');
watchFile(path.join(ROOT, 'CRON.md'), 'CRON.md');
watchFile(path.join(ROOT, 'LEARNING.md'), 'LEARNING.md');
watchFile(path.join(ROOT, 'README.md'), 'README.md');
watchFile(path.join(ROOT, 'registry/Daily-Design-Registry.md'), 'registry');
watchDir(path.join(ROOT, 'registry'), 'registry-dir', (f) => f.endsWith('.md') || f.endsWith('.xlsx'));

// each case folder
for (const name of fs.readdirSync(ROOT)) {
  if (!/^\d{4}-\d{2}-\d{2}-/.test(name)) continue;
  const casePath = path.join(ROOT, name);
  if (!fs.statSync(casePath).isDirectory()) continue;
  watchDir(casePath, name, (f) => f.endsWith('.md') || f.includes(`${path.sep}docs${path.sep}`) || f.endsWith('README.md'));
}

// new case folders at root
watchDir(ROOT, 'root', (f) => /^\d{4}-\d{2}-\d{2}-/.test(f.split(path.sep)[0]));

console.log('[watch] idle — Ctrl+C to stop');
