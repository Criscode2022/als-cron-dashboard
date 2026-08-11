#!/usr/bin/env node
/**
 * Reescribe tablas de directivas y anti-patrones en memory.md
 * desde un payload JSON (servidor local + Neon dual-write).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY = path.resolve(__dirname, '../../memory.md');

function escapeCell(s) {
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function buildDirectiveTable(items, withHits) {
  if (withHits) {
    const lines = [
      '| ID | Directiva | Origen | Hits |',
      '|----|-----------|--------|------|',
    ];
    for (const d of items) {
      lines.push(
        `| ${escapeCell(d.id)} | ${escapeCell(d.text)} | ${escapeCell(d.origin)} | ${Number(d.hits) || 0} |`,
      );
    }
    return lines.join('\n');
  }
  const lines = ['| ID | Directiva | Origen |', '|----|-----------|--------|'];
  for (const d of items) {
    lines.push(`| ${escapeCell(d.id)} | ${escapeCell(d.text)} | ${escapeCell(d.origin)} |`);
  }
  return lines.join('\n');
}

function buildApTable(items) {
  const lines = [
    '| ID | Anti-patrón | Señal de detección | Mitigación | Veces |',
    '|----|-------------|--------------------|------------|-------|',
  ];
  for (const a of items) {
    lines.push(
      `| ${escapeCell(a.id)} | ${escapeCell(a.name)} | ${escapeCell(a.signal)} | ${escapeCell(a.mitigation)} | ${Number(a.times) || 0} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Replace markdown table following a heading until end of contiguous table rows.
 */
function replaceTableAfterHeading(md, headingRegex, newTable) {
  const m = md.match(headingRegex);
  if (!m) throw new Error('Heading not found: ' + headingRegex);
  const headEnd = m.index + m[0].length;
  const after = md.slice(headEnd);
  const tableStartRel = after.search(/\n\|/);
  if (tableStartRel === -1) throw new Error('Table not found after heading');
  const tableStart = headEnd + tableStartRel + 1; // at |
  const lines = md.slice(tableStart).split('\n');
  let consumed = 0;
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      consumed += line.length + 1;
    } else {
      break;
    }
  }
  const tableEnd = tableStart + consumed - 1;
  return md.slice(0, tableStart) + newTable + '\n' + md.slice(tableEnd);
}

/**
 * Apply directive/AP edits to a memory markdown string (no disk I/O).
 */
export function applyMemoryEditsToString(md, { directives = null, antiPatterns = null } = {}) {
  let out = md;

  if (directives) {
    const p0 = directives.filter((d) => d.priority === 'P0');
    const p1 = directives.filter((d) => d.priority === 'P1');
    const p2 = directives.filter((d) => d.priority === 'P2');

    out = replaceTableAfterHeading(out, /### P0 — Bloqueantes de cierre\n/, buildDirectiveTable(p0, true));
    out = replaceTableAfterHeading(out, /### P1 — Obligatorias en ejecución\n/, buildDirectiveTable(p1, true));
    out = replaceTableAfterHeading(out, /### P2 — Preferibles \/ eficiencia\n/, buildDirectiveTable(p2, false));
  }

  if (antiPatterns) {
    out = replaceTableAfterHeading(
      out,
      /## 3\. Catálogo de anti-patrones \(no repetir\)\n/,
      buildApTable(antiPatterns),
    );
  }

  const stamp = `<!-- dashboard-edit ${new Date().toISOString()} -->`;
  if (!out.includes('dashboard-edit')) {
    out = out.trimEnd() + `\n\n${stamp}\n`;
  } else {
    out = out.replace(/<!-- dashboard-edit [\s\S]*?-->/, stamp);
  }

  return out;
}

/**
 * Write-back to monorepo memory.md on disk.
 */
export function applyMemoryEdits({ directives = null, antiPatterns = null }) {
  let md = fs.readFileSync(MEMORY, 'utf8');
  md = applyMemoryEditsToString(md, { directives, antiPatterns });
  fs.writeFileSync(MEMORY, md);
  return { ok: true, path: MEMORY, bytes: Buffer.byteLength(md) };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node apply-memory-edits.mjs payload.json');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(input, 'utf8'));
  console.log(applyMemoryEdits(payload));
}
