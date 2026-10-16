import { GuardrailError } from '@/core/errors';

/**
 * Translates the built-in Drive search grammar into Drive v3 `q`. A real tokenizer and recursive-descent parser:
 * nothing outside the grammar is passed through, and every value is re-escaped on output.
 */
type Tok = { k: 'str' | 'word' | 'op' | 'lp' | 'rp'; v: string };

const bad = (msg: string): never => {
  throw new GuardrailError('bad_query', `Cannot use this search query: ${msg}`);
};

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '(') (out.push({ k: 'lp', v: c }), i++);
    else if (c === ')') (out.push({ k: 'rp', v: c }), i++);
    else if (c === "'") {
      let v = '';
      let j = i + 1;
      for (;;) {
        if (j >= src.length) bad(`unterminated string starting at position ${i + 1}`);
        const d = src[j]!;
        if (d === '\\' && (src[j + 1] === "'" || src[j + 1] === '\\')) (v += src[j + 1], (j += 2));
        else if (d === "'") break;
        else (v += d, j++);
      }
      out.push({ k: 'str', v });
      i = j + 1;
    } else {
      const op = /^(<=|>=|!=|<|>|=)/.exec(src.slice(i));
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (op) (out.push({ k: 'op', v: op[1]! }), (i += op[1]!.length));
      else if (word) (out.push({ k: 'word', v: word[0] }), (i += word[0].length));
      else bad(`unexpected character "${c}" at position ${i + 1}`);
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const RFC3339 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
const TIME_OPS = ['<=', '<', '=', '!=', '>', '>='];
const TERMS: Record<string, { ops: string[]; kind: 'str' | 'time' | 'bool' }> = {
  title: { ops: ['contains', '=', '!='], kind: 'str' },
  fullText: { ops: ['contains'], kind: 'str' },
  mimeType: { ops: ['contains', '=', '!='], kind: 'str' },
  modifiedTime: { ops: TIME_OPS, kind: 'time' },
  viewedByMeTime: { ops: TIME_OPS, kind: 'time' },
  createdTime: { ops: TIME_OPS, kind: 'time' },
  parentId: { ops: ['=', '!='], kind: 'str' },
  owner: { ops: ['=', '!='], kind: 'str' },
  sharedWithMe: { ops: ['=', '!='], kind: 'bool' },
  starred: { ops: ['=', '!='], kind: 'bool' },
};

export interface TranslatedQuery {
  /** Drive v3 q; always excludes files in the bin. */
  q: string;
  hasFullText: boolean;
}

export function translateQuery(src: string | undefined): TranslatedQuery {
  const notInBin = 'trashed = false';
  if (!src || !src.trim()) return { q: notInBin, hasFullText: false };
  const toks = tokenize(src);
  let p = 0;
  let hasFullText = false;
  let depth = 0;
  const peek = () => toks[p];
  const isWord = (t: Tok | undefined, w: string) => t?.k === 'word' && t.v.toLowerCase() === w;
  const show = (t: Tok | undefined) => (t ? `"${t.k === 'str' ? `'${t.v}'` : t.v}"` : 'end of query');

  function expr(): string {
    if (++depth > 40) bad('too deeply nested');
    const parts = [and()];
    while (isWord(peek(), 'or')) (p++, parts.push(and()));
    depth--;
    return parts.length === 1 ? parts[0]! : `(${parts.join(' or ')})`;
  }
  function and(): string {
    const parts = [not()];
    while (isWord(peek(), 'and')) (p++, parts.push(not()));
    return parts.length === 1 ? parts[0]! : `(${parts.join(' and ')})`;
  }
  function not(): string {
    if (isWord(peek(), 'not')) {
      p++;
      if (++depth > 40) bad('too deeply nested');
      const inner = not();
      depth--;
      return `(not ${inner})`;
    }
    return primary();
  }
  function primary(): string {
    const t = toks[p++];
    if (t?.k === 'lp') {
      const inner = expr();
      if (toks[p++]?.k !== 'rp') bad('missing closing parenthesis');
      return inner;
    }
    if (t?.k !== 'word') return bad(`expected a search term but found ${show(t)}`);
    const spec = Object.hasOwn(TERMS, t.v) ? TERMS[t.v] : undefined;
    if (!spec) return bad(`unknown search term "${t.v}". Supported: ${Object.keys(TERMS).join(', ')}`);
    const o = toks[p++];
    const op = o?.k === 'op' ? o.v : o?.k === 'word' ? o.v.toLowerCase() : '';
    if (!spec.ops.includes(op)) return bad(`operator ${show(o)} is not valid for ${t.v} (use ${spec.ops.join(', ')})`);
    const v = toks[p++];
    if (spec.kind === 'bool') {
      if (v?.k !== 'word' || !/^(true|false)$/i.test(v.v)) return bad(`${t.v} needs true or false, found ${show(v)}`);
      const want = (v.v.toLowerCase() === 'true') === (op === '=');
      if (t.v === 'starred') return `starred = ${want}`;
      return want ? 'sharedWithMe' : '(not sharedWithMe)';
    }
    if (v?.k !== 'str') return bad(`${t.v} needs a single-quoted value, found ${show(v)}`);
    if (spec.kind === 'time' && (!RFC3339.test(v.v) || Number.isNaN(Date.parse(v.v)))) {
      return bad(`${t.v} needs an RFC 3339 time such as '2024-01-01T00:00:00Z', found ${show(v)}`);
    }
    const val = `'${esc(v.v)}'`;
    switch (t.v) {
      case 'title':
        return `name ${op} ${val}`;
      case 'parentId':
        return op === '=' ? `${val} in parents` : `(not ${val} in parents)`;
      case 'owner':
        return op === '=' ? `${val} in owners` : `(not ${val} in owners)`;
      case 'fullText':
        hasFullText = true;
        return `fullText contains ${val}`;
      default:
        return `${t.v} ${op} ${val}`;
    }
  }

  const body = expr();
  if (p < toks.length) bad(`unexpected ${show(toks[p])}`);
  return { q: `${body} and ${notInBin}`, hasFullText };
}
