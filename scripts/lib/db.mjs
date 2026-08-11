/**
 * Neon Postgres client for ALS Cron Dashboard.
 * Source of truth when DATABASE_URL is set.
 */
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve DATABASE_URL:
 * 1) process.env (Netlify injects site env here)
 * 2) local dashboard/.env only when not running on Netlify/Lambda
 */
export function getDatabaseUrl() {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.NETLIFY_DATABASE_URL,
    process.env.NEON_DATABASE_URL,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) {
      let url = String(c).trim().replace(/^["']|["']$/g, '');
      // Lambda/serverless: channel_binding=require often causes connection failures
      try {
        const u = new URL(url);
        u.searchParams.delete('channel_binding');
        if (!u.searchParams.get('sslmode')) u.searchParams.set('sslmode', 'require');
        url = u.toString();
      } catch {
        url = url.replace(/[&?]channel_binding=(require|prefer)/gi, '');
      }
      return url;
    }
  }

  // Serverless: never read filesystem for secrets
  if (
    process.env.NETLIFY === 'true' ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
  ) {
    return null;
  }

  try {
    const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
    if (!fs.existsSync(envPath)) return null;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^DATABASE_URL\s*=\s*(.+)$/);
      if (m) {
        let v = m[1].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        return v;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function hasDatabase() {
  return Boolean(getDatabaseUrl());
}

export function sql() {
  const url = getDatabaseUrl();
  if (!url) throw new Error('DATABASE_URL not configured');
  return neon(url);
}

function asDateStr(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

export async function pushSnapshot(snapshot, { source = 'sync' } = {}) {
  const db = sql();
  const now = new Date().toISOString();

  await db`DELETE FROM dashboard_meta`;
  for (const [key, value] of Object.entries(snapshot.meta || {})) {
    await db`
      INSERT INTO dashboard_meta (key, value, updated_at)
      VALUES (${key}, ${String(value ?? '')}, ${now}::timestamptz)
    `;
  }

  await db`DELETE FROM directives`;
  const directives = snapshot.directives || [];
  for (let i = 0; i < directives.length; i++) {
    const d = directives[i];
    await db`
      INSERT INTO directives (id, text, origin, hits, priority, sort_order, updated_at)
      VALUES (
        ${d.id}, ${d.text || ''}, ${d.origin || ''},
        ${Number(d.hits) || 0}, ${d.priority || 'P2'}, ${i}, ${now}::timestamptz
      )
    `;
  }

  await db`DELETE FROM anti_patterns`;
  const aps = snapshot.antiPatterns || [];
  for (let i = 0; i < aps.length; i++) {
    const a = aps[i];
    await db`
      INSERT INTO anti_patterns (id, name, signal, mitigation, times, sort_order, updated_at)
      VALUES (
        ${a.id}, ${a.name || ''}, ${a.signal || ''}, ${a.mitigation || ''},
        ${Number(a.times) || 0}, ${i}, ${now}::timestamptz
      )
    `;
  }

  await db`DELETE FROM project_docs`;
  await db`DELETE FROM projects`;

  const casesByDate = new Map((snapshot.cases || []).map((c) => [c.date, c]));
  const projects = snapshot.projects || [];
  const rows =
    projects.length > 0
      ? projects.map((p, i) => ({ p, c: casesByDate.get(p.date) || {}, i }))
      : (snapshot.cases || []).map((c, i) => ({
          p: {
            date: c.date,
            name: c.name,
            sector: c.sector,
            type: c.type,
            platform: c.platform,
            complexity: c.complexity,
            githubLabel: '',
            githubUrl: c.githubUrl,
            neon: c.neon,
            status: c.status,
            paperUrl: c.paperUrl,
            caseDir: c.dir,
          },
          c,
          i,
        }));

  for (const { p, c, i } of rows) {
    const projectDate = p.date;
    await db`
      INSERT INTO projects (
        project_date, name, sector, type, platform, complexity,
        github_label, github_url, neon, status, paper_url, case_dir, slug,
        style, palette, typography, demo, detail, readme, presentation,
        has_assets, sort_order, updated_at
      ) VALUES (
        ${projectDate}::date,
        ${p.name || c.name || ''},
        ${p.sector || c.sector || ''},
        ${p.type || c.type || ''},
        ${p.platform || c.platform || ''},
        ${p.complexity || c.complexity || ''},
        ${p.githubLabel || ''},
        ${p.githubUrl || c.githubUrl || ''},
        ${p.neon || c.neon || ''},
        ${p.status || c.status || ''},
        ${p.paperUrl || c.paperUrl || ''},
        ${p.caseDir || c.dir || ''},
        ${c.slug || (p.caseDir || c.dir || '').replace(/^\d{4}-\d{2}-\d{2}-/, '') || ''},
        ${c.style || ''},
        ${c.palette || ''},
        ${c.typography || ''},
        ${c.demo || ''},
        ${JSON.stringify(c.detail || {})}::jsonb,
        ${c.readme || ''},
        ${c.presentation || ''},
        ${Boolean(c.hasAssets)},
        ${i},
        ${now}::timestamptz
      )
    `;
    for (const doc of c.docs || []) {
      await db`
        INSERT INTO project_docs (project_date, path, name, bytes, lines, preview, content)
        VALUES (
          ${projectDate}::date, ${doc.path}, ${doc.name},
          ${Number(doc.bytes) || 0}, ${Number(doc.lines) || 0},
          ${doc.preview || ''}, ${doc.content || ''}
        )
      `;
    }
  }

  const files = snapshot.files || {};
  for (const [key, content] of Object.entries(files)) {
    await db`
      INSERT INTO files (key, content, updated_at)
      VALUES (${key}, ${content || ''}, ${now}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at
    `;
  }
  const keys = Object.keys(files);
  if (keys.length) {
    await db`DELETE FROM files WHERE NOT (key = ANY(${keys}))`;
  } else {
    await db`DELETE FROM files`;
  }

  if (snapshot.briefing) {
    await db`
      INSERT INTO briefing (id, for_date, body, updated_at)
      VALUES (1, ${snapshot.briefing.forDate || null}::date, ${snapshot.briefing.body || ''}, ${now}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        for_date = EXCLUDED.for_date, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at
    `;
  } else {
    await db`DELETE FROM briefing WHERE id = 1`;
  }

  await db`
    INSERT INTO snapshot_state (id, generated_at, root, source, updated_at)
    VALUES (1, ${snapshot.generatedAt || now}::timestamptz, ${snapshot.root || ''}, ${source}, ${now}::timestamptz)
    ON CONFLICT (id) DO UPDATE SET
      generated_at = EXCLUDED.generated_at, root = EXCLUDED.root,
      source = EXCLUDED.source, updated_at = EXCLUDED.updated_at
  `;

  return {
    ok: true,
    projects: rows.length,
    directives: directives.length,
    antiPatterns: aps.length,
    files: keys.length,
  };
}

export async function loadSnapshot() {
  const db = sql();

  const [stateRows, metaRows, dirRows, apRows, projectRows, docRows, fileRows, briefingRows] =
    await Promise.all([
      db`SELECT generated_at, root, source, updated_at FROM snapshot_state WHERE id = 1`,
      db`SELECT key, value FROM dashboard_meta ORDER BY key`,
      db`SELECT id, text, origin, hits, priority FROM directives ORDER BY sort_order, id`,
      db`SELECT id, name, signal, mitigation, times FROM anti_patterns ORDER BY sort_order, id`,
      db`SELECT
        project_date::text AS project_date,
        name, sector, type, platform, complexity,
        github_label, github_url, neon, status, paper_url, case_dir, slug,
        style, palette, typography, demo, detail, readme, presentation,
        has_assets, sort_order
      FROM projects ORDER BY sort_order, project_date DESC`,
      db`SELECT project_date::text AS project_date, path, name, bytes, lines, preview, content
         FROM project_docs ORDER BY project_date, path`,
      db`SELECT key, content FROM files`,
      db`SELECT for_date::text AS for_date, body FROM briefing WHERE id = 1`,
    ]);

  const meta = {};
  for (const r of metaRows) meta[r.key] = r.value;

  const docsByDate = new Map();
  for (const d of docRows) {
    const date = asDateStr(d.project_date);
    if (!docsByDate.has(date)) docsByDate.set(date, []);
    docsByDate.get(date).push({
      path: d.path,
      name: d.name,
      bytes: d.bytes,
      lines: d.lines,
      preview: d.preview || '',
      content: d.content || '',
    });
  }

  const cases = projectRows.map((p) => {
    const date = asDateStr(p.project_date);
    return {
      dir: p.case_dir || `${date}-${p.slug || ''}`,
      date,
      slug: p.slug || '',
      name: p.name,
      sector: p.sector || '',
      type: p.type || '',
      complexity: p.complexity || '',
      platform: p.platform || '',
      githubUrl: p.github_url || '',
      neon: p.neon || '',
      status: p.status || '',
      paperUrl: p.paper_url || '',
      style: p.style || '',
      palette: p.palette || '',
      typography: p.typography || '',
      demo: p.demo || '',
      detail: p.detail || {},
      docs: docsByDate.get(date) || [],
      readme: p.readme || '',
      presentation: p.presentation || '',
      hasAssets: Boolean(p.has_assets),
    };
  });

  const projectsOut = projectRows.map((p) => {
    const date = asDateStr(p.project_date);
    return {
      date,
      name: p.name,
      sector: p.sector || '',
      type: p.type || '',
      platform: p.platform || '',
      complexity: p.complexity || '',
      githubLabel: p.github_label || '',
      githubUrl: p.github_url || '',
      neon: p.neon || '',
      status: p.status || '',
      paperUrl: p.paper_url || '',
      caseDir: p.case_dir || '',
    };
  });

  const files = {};
  for (const f of fileRows) files[f.key] = f.content || '';

  let briefing = null;
  if (briefingRows[0]) {
    briefing = {
      forDate: asDateStr(briefingRows[0].for_date),
      body: briefingRows[0].body || '',
    };
  }

  const st = stateRows[0] || {};
  const generatedAt =
    st.generated_at instanceof Date
      ? st.generated_at.toISOString()
      : st.generated_at || new Date().toISOString();

  return {
    generatedAt,
    root: st.root || '',
    source: st.source || 'neon',
    meta,
    briefing,
    directives: dirRows.map((d) => ({
      id: d.id,
      text: d.text || '',
      origin: d.origin || '',
      hits: Number(d.hits) || 0,
      priority: d.priority || 'P2',
    })),
    antiPatterns: apRows.map((a) => ({
      id: a.id,
      name: a.name || '',
      signal: a.signal || '',
      mitigation: a.mitigation || '',
      times: Number(a.times) || 0,
    })),
    projects: projectsOut,
    cases,
    files,
  };
}

export async function saveFile(key, content) {
  const db = sql();
  const now = new Date().toISOString();
  await db`
    INSERT INTO files (key, content, updated_at)
    VALUES (${key}, ${content || ''}, ${now}::timestamptz)
    ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at
  `;
}

async function patchMemoryFileInNeon(payload) {
  try {
    const db = sql();
    const rows = await db`SELECT content FROM files WHERE key = 'memory'`;
    if (!rows[0]?.content) return { patched: false, reason: 'no memory file' };
    const { applyMemoryEditsToString } = await import('../apply-memory-edits.mjs');
    const next = applyMemoryEditsToString(rows[0].content, payload);
    await saveFile('memory', next);
    return { patched: true, bytes: Buffer.byteLength(next) };
  } catch (e) {
    return { patched: false, reason: String(e.message || e) };
  }
}

export async function saveDirectives(directives) {
  const db = sql();
  const now = new Date().toISOString();
  await db`DELETE FROM directives`;
  for (let i = 0; i < directives.length; i++) {
    const d = directives[i];
    await db`
      INSERT INTO directives (id, text, origin, hits, priority, sort_order, updated_at)
      VALUES (
        ${d.id}, ${d.text || ''}, ${d.origin || ''},
        ${Number(d.hits) || 0}, ${d.priority || 'P2'}, ${i}, ${now}::timestamptz
      )
    `;
  }
  await db`
    UPDATE snapshot_state SET
      generated_at = ${now}::timestamptz, source = 'dashboard-edit', updated_at = ${now}::timestamptz
    WHERE id = 1
  `;
  const memory = await patchMemoryFileInNeon({ directives });
  return { ok: true, count: directives.length, memory };
}

export async function saveAntiPatterns(antiPatterns) {
  const db = sql();
  const now = new Date().toISOString();
  await db`DELETE FROM anti_patterns`;
  for (let i = 0; i < antiPatterns.length; i++) {
    const a = antiPatterns[i];
    await db`
      INSERT INTO anti_patterns (id, name, signal, mitigation, times, sort_order, updated_at)
      VALUES (
        ${a.id}, ${a.name || ''}, ${a.signal || ''}, ${a.mitigation || ''},
        ${Number(a.times) || 0}, ${i}, ${now}::timestamptz
      )
    `;
  }
  await db`
    UPDATE snapshot_state SET
      generated_at = ${now}::timestamptz, source = 'dashboard-edit', updated_at = ${now}::timestamptz
    WHERE id = 1
  `;
  const memory = await patchMemoryFileInNeon({ antiPatterns });
  return { ok: true, count: antiPatterns.length, memory };
}
