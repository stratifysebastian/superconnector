import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ALLOWLIST, BANNED_PATTERNS } from './excluded';

export interface Violation {
  file: string;
  line: number;
  patternId: string;
  text: string;
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.claude']);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((e) => name.endsWith(e))) out.push(full);
  }
}

/** Undo trivial string splitting so `'/messages/' + 'send'` and `${'send'}` match like the plain literal. */
export function normalise(src: string): string {
  return src
    .replace(/\$\{\s*(['"`])([^'"`]*)\1\s*\}/g, '$2')
    .replace(/(['"`])\s*\+\s*(['"`])/g, '')
    .replace(/(['"`])\s*\.concat\(\s*(['"`])/g, '');
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function scanText(file: string, content: string): Violation[] {
  const found: Violation[] = [];
  const lines = content.split(/\r?\n/);
  const norm = normalise(content);
  for (const p of BANNED_PATTERNS) {
    const skip = p.onlyFiles ? !p.onlyFiles.includes(file) : (ALLOWLIST[p.id] ?? []).includes(file);
    if (skip) continue;
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
