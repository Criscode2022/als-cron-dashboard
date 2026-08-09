/* ALS Cron Dashboard — client */
const state = {
  snap: null,
  view: 'overview',
  selectedCase: null,
  selectedDoc: null,
  writable: false,
  dirtyDirectives: false,
  dirtyAP: false,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

async function api(path, opts) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(data?.error || r.statusText);
  return data;
}

async function loadSnapshot() {
  // Prefer live API when local server is up
  try {
    const health = await api('/api/health');
    state.writable = health.mode === 'local-write';
    state.snap = await api('/api/snapshot');
  } catch {
    state.writable = false;
    const r = await fetch('./data/snapshot.json');
    if (!r.ok) throw new Error('No snapshot.json — ejecuta npm run sync');
    state.snap = await r.json();
  }
  render();
}

function setView(view) {
  state.view = view;
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  renderMain();
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function render() {
  const s = state.snap;
  const mode = $('#modeBadge');
  mode.textContent = state.writable ? 'LOCAL WRITE' : 'STATIC / READ-ONLY';
  mode.className = 'badge-mode ' + (state.writable ? 'local' : 'static');
  $('#genAt').textContent = formatDate(s.generatedAt);
  $('#metaLine').textContent = [
    s.meta?.['Último proyecto'] || '',
    s.meta?.['Ejecuciones case'] || '',
    s.meta?.['Próxima ejecución'] || '',
  ]
    .filter(Boolean)
    .join(' · ');
  renderMain();
}

function renderMain() {
  const root = $('#main');
  const s = state.snap;
  if (!s) {
    root.innerHTML = '<p class="empty">Cargando…</p>';
    return;
  }
  if (state.view === 'overview') root.innerHTML = viewOverview(s);
  if (state.view === 'projects') root.innerHTML = viewProjects(s);
  if (state.view === 'case') root.innerHTML = viewCase(s);
  if (state.view === 'directives') root.innerHTML = viewDirectives(s);
  if (state.view === 'antipatterns') root.innerHTML = viewAntiPatterns(s);
  if (state.view === 'memory') root.innerHTML = viewFile(s, 'memory', 'memory.md');
  if (state.view === 'registry') root.innerHTML = viewFile(s, 'registry', 'registry/Daily-Design-Registry.md');
  if (state.view === 'cron') root.innerHTML = viewFile(s, 'cron', 'CRON.md');
  if (state.view === 'learning') root.innerHTML = viewFile(s, 'learning', 'LEARNING.md');
  if (state.view === 'briefing') root.innerHTML = viewBriefing(s);
  wireMain();
}

function viewOverview(s) {
  const p0 = s.directives.filter((d) => d.priority === 'P0').length;
  const apHot = s.antiPatterns.filter((a) => a.times >= 2).length;
  return `
    <div class="topbar">
      <div>
        <h1>ALS Cron Control</h1>
        <div class="meta-row" id="metaLine2">${escapeHtml(s.meta?.['Última fecha'] || '')} · ${escapeHtml(s.meta?.['Último proyecto'] || '')}</div>
      </div>
      <div class="actions">
        <button type="button" class="primary" data-act="sync">Sincronizar desde disco</button>
      </div>
    </div>
    <div class="grid-stats">
      <div class="stat"><div class="label">Ejecuciones</div><div class="value">${s.projects.length}</div></div>
      <div class="stat"><div class="label">Directivas</div><div class="value">${s.directives.length}</div></div>
      <div class="stat"><div class="label">P0 activas</div><div class="value">${p0}</div></div>
      <div class="stat"><div class="label">Anti-patrones</div><div class="value">${s.antiPatterns.length}</div></div>
      <div class="stat"><div class="label">AP calientes (≥2)</div><div class="value">${apHot}</div></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2>Últimas ejecuciones</h2></div>
      <div class="panel-b" style="overflow:auto">
        <table>
          <thead><tr><th>Fecha</th><th>Proyecto</th><th>Sector</th><th>Nivel</th><th>Paper</th><th>GitHub</th><th></th></tr></thead>
          <tbody>
            ${s.projects
              .slice(0, 12)
              .map(
                (p) => `
              <tr class="clickable" data-open-case="${escapeHtml(p.caseDir || '')}">
                <td>${escapeHtml(p.date)}</td>
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td>${escapeHtml(p.sector)}</td>
                <td>${escapeHtml(p.complexity)}</td>
                <td>${p.paperUrl ? `<a href="${escapeAttr(p.paperUrl)}" target="_blank" rel="noopener">Paper</a>` : '—'}</td>
                <td>${p.githubUrl ? `<a href="${escapeAttr(p.githubUrl)}" target="_blank" rel="noopener">Repo</a>` : '—'}</td>
                <td><button type="button" data-open-case="${escapeHtml(p.caseDir || '')}">Abrir</button></td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
    ${
      s.briefing
        ? `<div class="panel"><div class="panel-h"><h2>Briefing próximo: ${escapeHtml(s.briefing.forDate)}</h2></div>
      <div class="panel-b"><pre class="pre" style="max-height:240px">${escapeHtml(s.briefing.body)}</pre></div></div>`
        : ''
    }
  `;
}

function viewProjects(s) {
  return `
    <div class="topbar"><h1>Ejecuciones diarias</h1></div>
    <div class="panel"><div class="panel-b" style="overflow:auto">
      <table>
        <thead><tr><th>Fecha</th><th>Nombre</th><th>Sector</th><th>Tipo</th><th>Complejidad</th><th>Neon</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${s.projects
            .map(
              (p) => `<tr>
              <td>${escapeHtml(p.date)}</td>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td>${escapeHtml(p.sector)}</td>
              <td>${escapeHtml(p.type)}</td>
              <td>${escapeHtml(p.complexity)}</td>
              <td><code>${escapeHtml(p.neon || '—')}</code></td>
              <td>${escapeHtml(p.status || '')}</td>
              <td><button type="button" data-open-case="${escapeHtml(p.caseDir || '')}">Case</button></td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div></div>`;
}

function viewCase(s) {
  const c =
    s.cases.find((x) => x.dir === state.selectedCase) ||
    s.cases[0];
  if (!c) return '<p class="empty">No hay cases.</p>';
  state.selectedCase = c.dir;
  if (!state.selectedDoc && c.docs[0]) state.selectedDoc = c.docs[0].path;
  const doc = c.docs.find((d) => d.path === state.selectedDoc) || c.docs[0];
  return `
    <div class="topbar">
      <div>
        <h1>${escapeHtml(c.name)} <span style="color:var(--muted);font-weight:500;font-size:0.9rem">${escapeHtml(c.date)}</span></h1>
        <div class="meta-row">${escapeHtml(c.sector)} · ${escapeHtml(c.complexity)} · ${escapeHtml(c.dir)}</div>
      </div>
      <div class="links">
        ${c.paperUrl ? `<a class="chip" href="${escapeAttr(c.paperUrl)}" target="_blank" rel="noopener">Paper</a>` : ''}
        ${c.githubUrl ? `<a class="chip" href="${escapeAttr(c.githubUrl)}" target="_blank" rel="noopener">GitHub app</a>` : ''}
        ${c.neon ? `<span class="chip">Neon ${escapeHtml(c.neon)}</span>` : ''}
      </div>
    </div>
    <div class="layout-split">
      <div class="list">
        <button type="button" class="${state.selectedDoc === '__readme' ? 'active' : ''}" data-doc="__readme"><div class="t">README</div></button>
        <button type="button" class="${state.selectedDoc === '__presentation' ? 'active' : ''}" data-doc="__presentation"><div class="t">Presentación</div></button>
        ${c.docs
          .map(
            (d) => `<button type="button" class="${doc && d.path === doc.path ? 'active' : ''}" data-doc="${escapeAttr(d.path)}">
            <div class="t">${escapeHtml(d.name)}</div>
            <div class="s">${d.lines} líneas</div>
          </button>`,
          )
          .join('')}
      </div>
      <div class="doc-viewer">
        <div class="doc-toolbar">
          <span>${escapeHtml(state.selectedDoc === '__readme' ? 'README.md' : state.selectedDoc === '__presentation' ? 'presentation/executive-summary.md' : doc?.path || '')}</span>
        </div>
        <pre class="pre">${escapeHtml(
          state.selectedDoc === '__readme'
            ? c.readme
            : state.selectedDoc === '__presentation'
              ? c.presentation
              : doc?.content || '',
        )}</pre>
      </div>
    </div>`;
}

function viewDirectives(s) {
  const can = state.writable;
  return `
    <div class="topbar">
      <div>
        <h1>Directivas</h1>
        <div class="meta-row">${can ? 'Edición escribe en memory.md' : 'Solo lectura (despliegue estático o sin servidor)'}</div>
      </div>
      <div class="actions">
        <button type="button" data-act="add-directive" ${can ? '' : 'disabled'}>+ Directiva</button>
        <button type="button" class="primary" data-act="save-directives" ${can ? '' : 'disabled'}>Guardar en memory.md</button>
      </div>
    </div>
    <div class="edit-grid" id="dirList">
      ${s.directives
        .map(
          (d, i) => `
        <div class="card-edit" data-i="${i}">
          <div class="row"><label>ID</label><input class="id" data-f="id" value="${escapeAttr(d.id)}" ${can ? '' : 'readonly'} /></div>
          <div class="row"><label>Prioridad</label>
            <select data-f="priority" ${can ? '' : 'disabled'}>
              ${['P0', 'P1', 'P2'].map((p) => `<option value="${p}" ${d.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>
          <div class="row"><label>Directiva</label><textarea data-f="text" ${can ? '' : 'readonly'}>${escapeHtml(d.text)}</textarea></div>
          <div class="row"><label>Origen</label><input data-f="origin" value="${escapeAttr(d.origin)}" ${can ? '' : 'readonly'} /></div>
          <div class="row"><label>Hits</label><input type="number" min="0" data-f="hits" value="${Number(d.hits) || 0}" ${can ? '' : 'readonly'} /></div>
          <div style="text-align:right">${can ? `<button type="button" class="danger" data-del-dir="${i}">Eliminar</button>` : ''}</div>
        </div>`,
        )
        .join('')}
    </div>`;
}

function viewAntiPatterns(s) {
  const can = state.writable;
  return `
    <div class="topbar">
      <div>
        <h1>Anti-patrones</h1>
        <div class="meta-row">${can ? 'Edición escribe en memory.md' : 'Solo lectura'}</div>
      </div>
      <div class="actions">
        <button type="button" data-act="add-ap" ${can ? '' : 'disabled'}>+ Anti-patrón</button>
        <button type="button" class="primary" data-act="save-ap" ${can ? '' : 'disabled'}>Guardar en memory.md</button>
      </div>
    </div>
    <div class="edit-grid" id="apList">
      ${s.antiPatterns
        .map(
          (a, i) => `
        <div class="card-edit" data-i="${i}">
          <div class="row"><label>ID</label><input class="id" data-f="id" value="${escapeAttr(a.id)}" ${can ? '' : 'readonly'} /></div>
          <div class="row"><label>Nombre</label><input data-f="name" value="${escapeAttr(a.name)}" ${can ? '' : 'readonly'} /></div>
          <div class="row"><label>Señal</label><textarea data-f="signal" ${can ? '' : 'readonly'}>${escapeHtml(a.signal)}</textarea></div>
          <div class="row"><label>Mitigación</label><textarea data-f="mitigation" ${can ? '' : 'readonly'}>${escapeHtml(a.mitigation)}</textarea></div>
          <div class="row"><label>Veces</label><input type="number" min="0" data-f="times" value="${Number(a.times) || 0}" ${can ? '' : 'readonly'} /></div>
          <div style="text-align:right">${can ? `<button type="button" class="danger" data-del-ap="${i}">Eliminar</button>` : ''}</div>
        </div>`,
        )
        .join('')}
    </div>`;
}

function viewFile(s, key, label) {
  const content = s.files?.[key] || '';
  return `
    <div class="topbar"><h1>${escapeHtml(label)}</h1>
      <div class="actions"><button type="button" data-act="sync">Refrescar</button></div>
    </div>
    <div class="doc-viewer" style="max-height:80vh">
      <div class="doc-toolbar"><span>${escapeHtml(label)} · ${content.split('\n').length} líneas</span></div>
      <pre class="pre">${escapeHtml(content)}</pre>
    </div>`;
}

function viewBriefing(s) {
  const b = s.briefing;
  if (!b) return '<p class="empty">Sin briefing §8</p>';
  return `
    <div class="topbar"><h1>Briefing → ${escapeHtml(b.forDate)}</h1></div>
    <div class="doc-viewer" style="max-height:80vh">
      <div class="doc-toolbar">memory.md §8</div>
      <pre class="pre">${escapeHtml(b.body)}</pre>
    </div>`;
}

function collectDirectivesFromDom() {
  return $$('#dirList .card-edit').map((card) => ({
    id: $('[data-f=id]', card).value.trim(),
    priority: $('[data-f=priority]', card).value,
    text: $('[data-f=text]', card).value.trim(),
    origin: $('[data-f=origin]', card).value.trim(),
    hits: Number($('[data-f=hits]', card).value) || 0,
  }));
}

function collectAPFromDom() {
  return $$('#apList .card-edit').map((card) => ({
    id: $('[data-f=id]', card).value.trim(),
    name: $('[data-f=name]', card).value.trim(),
    signal: $('[data-f=signal]', card).value.trim(),
    mitigation: $('[data-f=mitigation]', card).value.trim(),
    times: Number($('[data-f=times]', card).value) || 0,
  }));
}

function wireMain() {
  $$('[data-act=sync]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        if (state.writable) await api('/api/sync', { method: 'POST', body: '{}' });
        await loadSnapshot();
        toast('Sincronizado desde archivos locales');
      } catch (e) {
        toast(String(e.message || e), true);
      }
    }),
  );

  $$('[data-open-case]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = el.getAttribute('data-open-case');
      if (!dir) return;
      state.selectedCase = dir;
      state.selectedDoc = null;
      setView('case');
    }),
  );

  $$('[data-doc]').forEach((b) =>
    b.addEventListener('click', () => {
      state.selectedDoc = b.getAttribute('data-doc');
      renderMain();
    }),
  );

  const addDir = $('[data-act=add-directive]');
  if (addDir) {
    addDir.addEventListener('click', () => {
      state.snap.directives.push({
        id: 'D-P2-NEW',
        priority: 'P2',
        text: 'Nueva directiva',
        origin: 'dashboard',
        hits: 0,
      });
      renderMain();
    });
  }

  const saveDir = $('[data-act=save-directives]');
  if (saveDir) {
    saveDir.addEventListener('click', async () => {
      try {
        const directives = collectDirectivesFromDom();
        await api('/api/directives', {
          method: 'POST',
          body: JSON.stringify({ directives }),
        });
        await loadSnapshot();
        toast('Directivas guardadas en memory.md');
      } catch (e) {
        toast(String(e.message || e), true);
      }
    });
  }

  $$('[data-del-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-del-dir'));
      state.snap.directives.splice(i, 1);
      renderMain();
    }),
  );

  const addAp = $('[data-act=add-ap]');
  if (addAp) {
    addAp.addEventListener('click', () => {
      state.snap.antiPatterns.push({
        id: 'AP-NEW',
        name: 'Nuevo anti-patrón',
        signal: '',
        mitigation: '',
        times: 0,
      });
      renderMain();
    });
  }

  const saveAp = $('[data-act=save-ap]');
  if (saveAp) {
    saveAp.addEventListener('click', async () => {
      try {
        const antiPatterns = collectAPFromDom();
        await api('/api/anti-patterns', {
          method: 'POST',
          body: JSON.stringify({ antiPatterns }),
        });
        await loadSnapshot();
        toast('Anti-patrones guardados en memory.md');
      } catch (e) {
        toast(String(e.message || e), true);
      }
    });
  }

  $$('[data-del-ap]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-del-ap'));
      state.snap.antiPatterns.splice(i, 1);
      renderMain();
    }),
  );
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

// boot
$$('.nav button').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view)),
);
loadSnapshot().catch((e) => {
  $('#main').innerHTML = `<p class="empty">Error cargando datos: ${escapeHtml(e.message)}. Ejecuta <code>npm run sync</code> y <code>npm start</code>.</p>`;
});
