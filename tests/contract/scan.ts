import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ALLOWED_LITERALS, ALLOWLIST, BANNED_PATTERNS, type BannedPattern } from './excluded';

export interface Violation {
  file: string;
  line: number;
  patternId: string;
  text: string;
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.claude']);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((e) => name.endsWith(e))) out.push(full);
  }
}

const JOIN_OF_LITERALS = /\[((?:\s*(['"`])[^'"`\n]*\2\s*,?)+)\s*\]\s*\.\s*join\(\s*(['"`])([^'"`\n]*)\3\s*\)/g;

/** Undo trivial string building so `'/messages/' + 'send'`, `${'send'}` and `['a','b'].join('/')` match like the plain literal. */
export function normalise(src: string): string {
  return src
    .replace(JOIN_OF_LITERALS, (_m, items: string, _q: string, _q2: string, sep: string) => {
      const parts = [...items.matchAll(/(['"`])([^'"`\n]*)\1/g)].map((x) => x[2] ?? '');
      return `'${parts.join(sep)}'`;
    })
    .replace(/\$\{\s*(['"`])([^'"`]*)\1\s*\}/g, '$2')
    .replace(/(['"`])\s*\+\s*(['"`])/g, '')
    .replace(/(['"`])\s*\.concat\(\s*(['"`])/g, '');
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function applies(p: BannedPattern, file: string): boolean {
  if (p.onlyFiles) return p.onlyFiles.includes(file);
  if ((ALLOWLIST[p.id] ?? []).includes(file)) return false;
  if (p.onlyUnder && !p.onlyUnder.some((d) => file.startsWith(d))) return false;
  if (p.skipUnder?.some((d) => file.startsWith(d))) return false;
  if (p.skipFiles?.includes(file)) return false;
  return true;
}

/** Remove the exact literals a file may contain for this pattern; anything else in the file still matches. */
function stripAllowed(patternId: string, file: string, content: string): string {
  let out = content;
  for (const lit of ALLOWED_LITERALS[patternId]?.[file] ?? []) {
    // An allowed string must be the whole literal: `.../token` is allowed, `.../tokeninfo` or `.../token/x` is not.
    const re =
      typeof lit === 'string' ? new RegExp(`${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/.%-])`, 'g') : lit;
    out = out.replace(re, "''");
  }
  return out;
}

function scanText(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  for (const p of BANNED_PATTERNS) {
    if (!applies(p, file)) continue;
    const content = stripAllowed(p.id, file, source);
    const lines = content.split(/\r?\n/);
    const norm = normalise(content);
    const seen = new Set<string>();
    // Pass 1: line by line on the raw source.
    const lineRe = new RegExp(p.regex.source, p.regex.flags.replace('g', ''));
    lines.forEach((text, i) => {
      const m = lineRe.exec(text);
      if (m) {
        seen.add(m[0]);
        found.push({ file, line: i + 1, patternId: p.id, text: text.trim().slice(0, 200) });
      }
    });
    // Pass 2: whole file, normalised, for constructs spanning lines or built from split strings.
    const wholeRe = new RegExp(p.regex.source, p.regex.flags.includes('g') ? p.regex.flags : `${p.regex.flags}g`);
    for (const m of norm.matchAll(wholeRe)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      found.push({
        file,
        line: lineOf(norm, m.index ?? 0),
        patternId: p.id,
        text: m[0].replace(/\s+/g, ' ').trim().slice(0, 200),
      });
    }
  }
  return found;
}

function repoRelative(p: string): string {
  return relative(process.cwd(), p).split(sep).join('/');
}

/**
 * Scan sources for banned patterns. With `files` (repo-relative path -> content) only those are scanned and
 * the disk is not touched. Line numbers from the normalised whole-file pass are approximate when strings were
 * concatenated across lines.
 */
export function scanSources(rootDirs: string[] = ['src'], files?: Record<string, string>): Violation[] {
  const out: Violation[] = [];
  if (files) {
    for (const [file, content] of Object.entries(files)) out.push(...scanText(file, content));
    return out;
  }
  for (const root of rootDirs) {
    const paths: string[] = [];
    try {
      walk(root, paths);
    } catch {
      continue; // missing root: nothing to scan
    }
    for (const full of paths.sort()) out.push(...scanText(repoRelative(full), readFileSync(full, 'utf8')));
  }
  return out;
}

export function formatViolations(vs: Violation[]): string {
  return vs.map((v) => `  ${v.file}:${v.line} [${v.patternId}] ${v.text}`).join('\n');
}
