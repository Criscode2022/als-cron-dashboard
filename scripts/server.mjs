#!/usr/bin/env node
/**
 * Servidor local del ALS Dashboard.
 * Fuente de verdad: Neon (DATABASE_URL). El monorepo se usa para:
 *   - sync (push monorepo → Neon)
 *   - write-back dual de memory.md al editar directivas/AP (si existe el repo)
 *
 * - GET  /api/health
 * - GET  /api/snapshot   — desde Neon
 * - POST /api/sync       — monorepo → snapshot local + Neon
 * - POST /api/directives — Neon (+ memory.md local)
 * - POST /api/anti-patterns
 * - GET  /api/file?path= — docs desde Neon (caseDir/path) o disco
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  hasDatabase,
  loadSnapshot,
  saveDirectives,
  saveAntiPatterns,
  saveFile,
} from './lib/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.resolve(__dirname, '..');
const ROOT = path.resolve(DASH, '..');
const PUBLIC = path.join(DASH, 'public');
const PORT = Number(process.env.PORT || 4177);

function runSync() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'sync-data.mjs')], {
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'sync failed');
  return r.stdout;
}

async function loadApply() {
  const mod = await import(pathToFileURL(path.join(__dirname, 'apply-memory-edits.mjs')).href);
  return mod.applyMemoryEdits;
}

function safePath(rel) {
  const cleaned = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(ROOT, cleaned);
  if (!full.startsWith(ROOT)) return null;
  return full;
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

const neonReady = hasDatabase();

// Optional initial monorepo → Neon if local files exist
if (neonReady && process.env.SKIP_INITIAL_SYNC !== '1') {
  try {
    console.log(runSync());
  } catch (e) {
    console.warn('initial sync warning:', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204, '');
  }

  try {
    if (url.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        root: ROOT,
        mode: neonReady ? 'neon-write' : 'local-write',
        source: neonReady ? 'neon' : 'local-files',
        neon: neonReady,
      });
    }

    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const out = runSync();
      return send(res, 200, { ok: true, log: out, source: neonReady ? 'neon' : 'local' });
    }

    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      if (neonReady) {
        const snap = await loadSnapshot();
        return send(res, 200, snap);
      }
      // fallback local file
      const snapPath = path.join(PUBLIC, 'data/snapshot.json');
      if (!fs.existsSync(snapPath)) runSync();
      const snap = fs.readFileSync(snapPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(snap);
    }

    if (url.pathname === '/api/directives' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.directives)) return send(res, 400, { error: 'directives[] required' });

      let local = null;
      try {
        const apply = await loadApply();
        local = apply({ directives: body.directives });
      } catch (e) {
        console.warn('local memory.md write skipped:', e.message);
      }

      if (neonReady) {
        await saveDirectives(body.directives);
        // keep files.memory in Neon in sync if we rewrote local
        try {
          const memPath = path.join(ROOT, 'memory.md');
          if (fs.existsSync(memPath)) {
            await saveFile('memory', fs.readFileSync(memPath, 'utf8'));
          }
        } catch (e) {
          console.warn('neon memory file update:', e.message);
        }
      } else if (!local) {
        return send(res, 500, { error: 'No Neon and local memory write failed' });
      }

      return send(res, 200, {
        ok: true,
        source: neonReady ? 'neon' : 'local',
        local,
      });
    }

    if (url.pathname === '/api/anti-patterns' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.antiPatterns)) {
        return send(res, 400, { error: 'antiPatterns[] required' });
      }

      let local = null;
      try {
        const apply = await loadApply();
        local = apply({ antiPatterns: body.antiPatterns });
      } catch (e) {
        console.warn('local memory.md write skipped:', e.message);
      }

      if (neonReady) {
        await saveAntiPatterns(body.antiPatterns);
        try {
          const memPath = path.join(ROOT, 'memory.md');
          if (fs.existsSync(memPath)) {
            await saveFile('memory', fs.readFileSync(memPath, 'utf8'));
          }
        } catch (e) {
          console.warn('neon memory file update:', e.message);
        }
      } else if (!local) {
        return send(res, 500, { error: 'No Neon and local memory write failed' });
      }

      return send(res, 200, {
        ok: true,
        source: neonReady ? 'neon' : 'local',
        local,
      });
    }

    if (url.pathname === '/api/file' && req.method === 'GET') {
      const rel = url.searchParams.get('path');
      if (!rel) return send(res, 400, { error: 'path required' });

      // Prefer Neon: path like "2026-08-09-rele/docs/01.md" or files keys
      if (neonReady) {
        const snap = await loadSnapshot();
        if (snap.files && snap.files[rel]) {
          return send(res, 200, { path: rel, content: snap.files[rel], source: 'neon' });
        }
        // case docs: "{caseDir}/docs/..."
        for (const c of snap.cases || []) {
          const prefix = c.dir + '/';
          if (rel.startsWith(prefix)) {
            const sub = rel.slice(prefix.length);
            const doc = (c.docs || []).find((d) => d.path === sub || d.path === rel);
            if (doc) return send(res, 200, { path: rel, content: doc.content, source: 'neon' });
          }
          const doc = (c.docs || []).find((d) => `${c.dir}/${d.path}` === rel);
          if (doc) return send(res, 200, { path: rel, content: doc.content, source: 'neon' });
        }
      }

      const full = safePath(rel);
      if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return send(res, 404, { error: 'not found' });
      }
      if (!/\.(md|json|txt|csv)$/i.test(full)) return send(res, 403, { error: 'type not allowed' });
      return send(res, 200, { path: rel, content: fs.readFileSync(full, 'utf8'), source: 'disk' });
    }

    // static
    let filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC, 'index.html');
    }
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(buf);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`ALS Dashboard  http://127.0.0.1:${PORT}`);
  console.log(`Repo root      ${ROOT}`);
  console.log(`Source        ${neonReady ? 'Neon (DATABASE_URL)' : 'local files only'}`);
  console.log(`Write-back    ${neonReady ? 'Neon + memory.md' : 'memory.md'}`);
});
