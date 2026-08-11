#!/usr/bin/env node
/**
 * sync-data.mjs — regenera data/snapshot.json desde el monorepo ux-projects.
 * Uso: node scripts/sync-data.mjs
 * Se invoca en WRITEBACK del cron y al arrancar el dashboard local.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.resolve(__dirname, '../data/snapshot.json');
const OUT_PUBLIC = path.resolve(__dirname, '../public/data/snapshot.json');

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function listCaseDirs() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
}

function parseMarkdownTableRows(section) {
  const lines = section.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\|\s*-+/.test(line) || line.includes('---')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (!cells.length) continue;
    // skip header-like first data if ID column is "ID"
    if (cells[0] === 'ID' || cells[0] === 'Campo' || cells[0] === 'Fecha') {
      if (rows.length === 0) {
        rows._headers = cells;
        continue;
      }
    }
    rows.push(cells);
  }
  return rows;
}

function extractSection(md, headingRegex, { stopAtSameLevel = true } = {}) {
  const m = md.match(headingRegex);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  // Detect heading depth of the matched heading (## vs ###)
  const hashes = (m[0].match(/^#+/) || ['##'])[0].length;
  const stopRe = stopAtSameLevel
    ? new RegExp(`\\n#{1,${hashes}}\\s+`)
    : /\n##\s+/;
  const next = rest.search(stopRe);
  return next === -1 ? rest : rest.slice(0, next);
}

function parseDirectives(memory) {
  const p0 = extractSection(memory, /### P0[^\n]*/);
  const p1 = extractSection(memory, /### P1[^\n]*/);
  const p2 = extractSection(memory, /### P2[^\n]*/);

  function parsePriority(section, priority) {
    const rows = parseMarkdownTableRows(section);
    return rows
      .filter((c) => c[0] && c[0].startsWith('D-'))
      .map((c) => ({
        id: c[0],
        text: c[1] || '',
        origin: c[2] || '',
        hits: Number(String(c[3] || '0').replace(/[^\d]/g, '')) || 0,
        priority,
      }));
  }

  // P2 table has only 3 cols
  const p2Rows = parseMarkdownTableRows(p2)
    .filter((c) => c[0] && c[0].startsWith('D-'))
    .map((c) => ({
      id: c[0],
      text: c[1] || '',
      origin: c[2] || '',
      hits: 0,
      priority: 'P2',
    }));

  return [...parsePriority(p0, 'P0'), ...parsePriority(p1, 'P1'), ...p2Rows];
}

function parseAntiPatterns(memory) {
  const section = extractSection(memory, /## 3\.\s*Catálogo de anti-patrones[^\n]*/i);
  const rows = parseMarkdownTableRows(section);
  return rows
    .filter((c) => c[0] && c[0].startsWith('AP-'))
    .map((c) => ({
      id: c[0],
      name: c[1] || '',
      signal: c[2] || '',
      mitigation: c[3] || '',
      times: Number(String(c[4] || '0').replace(/[^\d]/g, '')) || 0,
    }));
}

function parseMetaTable(memory) {
  const meta = {};
  const re = /\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/g;
  const head = memory.slice(0, 2500);
  let m;
  while ((m = re.exec(head))) {
    const k = m[1].replace(/\*\*/g, '').trim();
    const v = m[2].replace(/\*\*/g, '').trim();
    if (k === 'Campo' || k === '-----') continue;
    if (['Creado', 'Versión del protocolo', 'Ejecuciones case', 'Última fecha', 'Último proyecto', 'Próxima ejecución'].includes(k)) {
      meta[k] = v;
    }
  }
  return meta;
}

function parseBriefing(memory) {
  const m = memory.match(/### Para (\d{4}-\d{2}-\d{2})([\s\S]*?)(?=\n### |\n## |\n---\n)/);
  if (!m) return null;
  return { forDate: m[1], body: m[2].trim() };
}

function parseRegistryIndex(reg) {
  const section = extractSection(reg, /## Índice rápido/);
  const rows = parseMarkdownTableRows(section);
  return rows
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c[0] || ''))
    .map((c) => {
      const gh = (c[6] || '').match(/\[([^\]]+)\]\(([^)]+)\)/);
      return {
        date: c[0],
        name: c[1],
        sector: c[2],
        type: c[3],
        platform: c[4],
        complexity: c[5],
        githubLabel: gh ? gh[1] : c[6],
        githubUrl: gh ? gh[2] : '',
        neon: c[7],
        status: c[8],
      };
    });
}

function parseDetailedEntry(reg, date, name) {
  const re = new RegExp(`### ${date} — ${name}([\\s\\S]*?)(?=\\n### |$)`);
  const m = reg.match(re);
  if (!m) return {};
  const fields = {};
  for (const line of m[1].split('\n')) {
    const fm = line.match(/\|\s*\*\*([^*]+)\*\*\s*\|\s*(.+?)\s*\|/);
    if (fm) fields[fm[1]] = fm[2].replace(/`/g, '').trim();
  }
  return fields;
}

function walkDocs(caseDir) {
  const docsDir = path.join(ROOT, caseDir, 'docs');
  if (!fs.existsSync(docsDir)) return [];
  return fs
    .readdirSync(docsDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const full = path.join(docsDir, f);
      const content = read(full) || '';
      return {
        path: `docs/${f}`,
        name: f,
        bytes: Buffer.byteLength(content),
        lines: content.split('\n').length,
        preview: content.slice(0, 400),
        content,
      };
    });
}

function buildSnapshot() {
  const memory = read(path.join(ROOT, 'memory.md')) || '';
  const registry = read(path.join(ROOT, 'registry/Daily-Design-Registry.md')) || '';
  const cron = read(path.join(ROOT, 'CRON.md')) || '';
  const learning = read(path.join(ROOT, 'LEARNING.md')) || '';
  const readme = read(path.join(ROOT, 'README.md')) || '';

  const index = parseRegistryIndex(registry);
  const cases = listCaseDirs().map((dir) => {
    const slug = dir.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const date = dir.slice(0, 10);
    const idx = index.find((p) => p.date === date) || {};
    const detail = parseDetailedEntry(registry, date, idx.name || slug.toUpperCase());
    const paper =
      detail.Paper ||
      (detail['Enlace'] || '') ||
      '';
    const paperUrl = (paper.match(/https?:\/\/\S+/) || [''])[0];
    const readmeCase = read(path.join(ROOT, dir, 'README.md')) || '';
    const presentation = read(path.join(ROOT, dir, 'presentation/executive-summary.md')) || '';
    return {
      dir,
      date,
      slug,
      name: idx.name || detail.Nombre || slug.toUpperCase(),
      sector: idx.sector || detail.Sector || '',
      type: idx.type || detail.Tipo || '',
      complexity: idx.complexity || detail.Complejidad || detail['Nivel de complejidad'] || '',
      platform: idx.platform || detail.Plataforma || '',
      githubUrl: idx.githubUrl || (detail.Repo || '').match(/https?:\/\/\S+/)?.[0] || '',
      neon: idx.neon || detail.Neon || '',
      status: idx.status || detail.Estado || '',
      paperUrl: paperUrl || (detail.Paper || '').match(/https?:\/\/\S+/)?.[0] || '',
      style: detail['Estilo visual'] || detail.Estilo || '',
      palette: detail['Paleta principal'] || detail.Paleta || '',
      typography: detail.Tipografía || '',
      demo: detail.Demo || detail['Demo staff'] || '',
      detail,
      docs: walkDocs(dir),
      readme: readmeCase,
      presentation,
      hasAssets: fs.existsSync(path.join(ROOT, dir, 'assets')),
    };
  });

  // enrich index with paper from cases
  const projects = index.map((p) => {
    const c = cases.find((x) => x.date === p.date);
    return { ...p, paperUrl: c?.paperUrl || '', caseDir: c?.dir || '' };
  });

  return {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    meta: parseMetaTable(memory),
    briefing: parseBriefing(memory),
    directives: parseDirectives(memory),
    antiPatterns: parseAntiPatterns(memory),
    projects,
    cases,
    files: {
      memory,
      registry,
      cron,
      learning,
      readme,
    },
  };
}

const snapshot = buildSnapshot();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
const json = JSON.stringify(snapshot, null, 2);
fs.writeFileSync(OUT, json);
fs.writeFileSync(OUT_PUBLIC, json);
console.log(
  `snapshot OK → ${OUT_PUBLIC}\n  projects=${snapshot.projects.length} directives=${snapshot.directives.length} antiPatterns=${snapshot.antiPatterns.length} cases=${snapshot.cases.length}`,
);

// Push to Neon when DATABASE_URL is available (source of truth for dashboard)
const skipNeon = process.env.SKIP_NEON === '1' || process.argv.includes('--local-only');
if (!skipNeon) {
  try {
    const { hasDatabase, pushSnapshot } = await import('./lib/db.mjs');
    if (hasDatabase()) {
      const r = await pushSnapshot(snapshot, { source: 'sync-data' });
      console.log(
        `neon OK → projects=${r.projects} directives=${r.directives} antiPatterns=${r.antiPatterns} files=${r.files}`,
      );
    } else {
      console.log('neon skip → DATABASE_URL not set (see dashboard/.env.example)');
    }
  } catch (e) {
    console.error('neon push failed:', e.message || e);
    process.exitCode = 1;
  }
}
