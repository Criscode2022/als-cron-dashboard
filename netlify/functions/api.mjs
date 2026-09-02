/**
 * Netlify Function — ALS Dashboard API (Neon).
 * Classic handler only (most reliable on Netlify).
 * Redirect: /api/* → /.netlify/functions/api/:splat  (netlify.toml)
 */
import { neon } from '@neondatabase/serverless';

function getDatabaseUrl() {
  const raw =
    process.env.DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL ||
    process.env.NEON_DATABASE_URL ||
    '';
  if (!raw) return null;
  let url = String(raw).trim().replace(/^["']|["']$/g, '');
  // channel_binding=require often breaks serverless/Lambda drivers → 502
  try {
    const u = new URL(url);
    u.searchParams.delete('channel_binding');
    if (!u.searchParams.get('sslmode')) u.searchParams.set('sslmode', 'require');
    url = u.toString();
  } catch {
    url = url
      .replace(/[&?]channel_binding=require/gi, '')
      .replace(/[&?]channel_binding=prefer/gi, '');
  }
  return url;
}

function sql() {
  const url = getDatabaseUrl();
  if (!url) throw new Error('DATABASE_URL not configured in Netlify function env');
  return neon(url);
}

function asDateStr(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

/** Normalize path: /api/snapshot | /snapshot | /.netlify/functions/api/snapshot */
function routePath(event) {
  let p = event.path || '';
  if (event.rawUrl) {
    try {
      p = new URL(event.rawUrl).pathname;
    } catch {
      /* keep */
    }
  }
  // strip function prefix
  p = p.replace(/^\/\.netlify\/functions\/api\/?/, '/');
  // strip /api prefix
  p = p.replace(/^\/api\/?/, '/');
  // splat may leave leading slash only
  p = p.replace(/\/+$/, '') || '/';
  // query fallback
  if (p === '/' && event.queryStringParameters?.path) {
    p = '/' + String(event.queryStringParameters.path).replace(/^\//, '');
  }
  return p; // e.g. /health, /snapshot, /directives
}

async function loadSnapshot() {
  const db = sql();
  const [stateRows, metaRows, dirRows, apRows, projectRows, docRows, fileRows, briefingRows] =
    await Promise.all([
      db`SELECT generated_at, root, source FROM snapshot_state WHERE id = 1`,
      db`SELECT key, value FROM dashboard_meta`,
      db`SELECT id, text, origin, hits, priority FROM directives ORDER BY sort_order, id`,
      db`SELECT id, name, signal, mitigation, times FROM anti_patterns ORDER BY sort_order, id`,
      db`SELECT
        project_date::text AS project_date, name, sector, type, platform, complexity,
        github_label, github_url, neon, status, paper_url, case_dir, slug,
        style, palette, typography, demo, detail, readme, presentation, has_assets
      FROM projects ORDER BY sort_order, project_date DESC`,
      // Limit doc payload for function size: full content needed by UI case viewer
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

  const projects = projectRows.map((p) => {
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
    projects,
    cases,
    files,
  };
}

async function saveDirectives(directives) {
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
      generated_at = ${now}::timestamptz,
      source = 'dashboard-edit',
      updated_at = ${now}::timestamptz
    WHERE id = 1
  `;
  return { ok: true, count: directives.length };
}

async function saveAntiPatterns(antiPatterns) {
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
      generated_at = ${now}::timestamptz,
      source = 'dashboard-edit',
      updated_at = ${now}::timestamptz
    WHERE id = 1
  `;
  return { ok: true, count: antiPatterns.length };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

export async function handler(event) {
  try {
    const method = event.httpMethod || 'GET';
    if (method === 'OPTIONS') {
      return { statusCode: 204, body: '' };
    }

    const path = routePath(event);
    const dbUrl = getDatabaseUrl();

    // Always answer health without needing DB success for diagnostics
    if (path === '/health' || path === 'health') {
      return json(200, {
        ok: true,
        mode: dbUrl ? 'neon-write' : 'no-db',
        source: dbUrl ? 'neon' : 'none',
        neon: Boolean(dbUrl),
        databaseUrlConfigured: Boolean(dbUrl),
        platform: 'netlify',
        path,
        method,
      });
    }

    if (!dbUrl) {
      return json(503, {
        error:
          'DATABASE_URL not set on Netlify function. Site settings → Env vars → scopes Functions + Runtime → redeploy.',
        path,
        platform: 'netlify',
      });
    }

    if ((path === '/snapshot' || path === 'snapshot') && method === 'GET') {
      const snap = await loadSnapshot();
      return json(200, snap);
    }

    if ((path === '/sync' || path === 'sync') && method === 'POST') {
      const snap = await loadSnapshot();
      return json(200, {
        ok: true,
        log: 'Reloaded from Neon',
        generatedAt: snap.generatedAt,
        source: 'neon',
      });
    }

    if ((path === '/directives' || path === 'directives') && method === 'POST') {
      const body = parseBody(event);
      if (!Array.isArray(body.directives)) {
        return json(400, { error: 'directives[] required' });
      }
      const result = await saveDirectives(body.directives);
      return json(200, { ok: true, source: 'neon', ...result });
    }

    if ((path === '/anti-patterns' || path === 'anti-patterns') && method === 'POST') {
      const body = parseBody(event);
      if (!Array.isArray(body.antiPatterns)) {
        return json(400, { error: 'antiPatterns[] required' });
      }
      const result = await saveAntiPatterns(body.antiPatterns);
      return json(200, { ok: true, source: 'neon', ...result });
    }

    return json(404, {
      error: 'not found',
      path,
      method,
      hint: 'Use /api/health /api/snapshot /api/directives /api/anti-patterns',
    });
  } catch (e) {
    console.error('api function error', e);
    return json(500, {
      error: String(e && e.message ? e.message : e),
      stack: process.env.NODE_ENV === 'development' ? String(e.stack || '') : undefined,
      platform: 'netlify',
    });
  }
}
