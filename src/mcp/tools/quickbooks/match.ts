/** Name matching for the product and customer searches: a simple similarity score, and the found/clarification verdict. */
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const bigrams = (s: string): string[] => {
  const t = s.replace(/ /g, '');
  return t.length < 2 ? [t] : Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2));
};

/** 1 for the same name (ignoring case and punctuation); otherwise the better of bigram overlap and whole-phrase containment. */
export function similarity(a: string, b: string): number {
  const [x, y] = [words(a), words(b)];
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [p, q] = [bigrams(x), bigrams(y)];
  const pool = [...q];
  let shared = 0;
  for (const g of p) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      shared++;
      pool.splice(i, 1);
    }
  }
  const dice = (2 * shared) / (p.length + q.length);
  const contained = x.includes(y) || y.includes(x) ? 0.85 : 0;
  return Math.round(Math.max(dice, contained) * 100) / 100;
}

export type MatchQuality = 'exact' | 'high' | 'partial' | 'low' | 'no_match';

export interface Verdict<T> {
  found: boolean;
  matches: T[];
  best_match: T | null;
  requires_clarification: boolean;
  match_quality: MatchQuality;
}

/** Scored candidates -> best five, and whether the caller must ask which one was meant. */
export function verdict<T extends { score: number }>(scored: T[]): Verdict<T> {
  const matches = [...scored].sort((a, b) => b.score - a.score).slice(0, 5);
  const [best, second] = matches;
  if (!best) return { found: false, matches: [], best_match: null, requires_clarification: false, match_quality: 'no_match' };
  const quality: MatchQuality = best.score >= 1 ? 'exact' : best.score >= 0.8 ? 'high' : best.score >= 0.5 ? 'partial' : 'low';
  const close = second !== undefined && (best.score >= 1 ? second.score >= 1 : best.score - second.score < 0.15);
  return { found: true, matches, best_match: best, requires_clarification: close || best.score < 0.5, match_quality: quality };
}

/** Longest word of 3+ letters: the fallback search term when the whole phrase finds nothing. */
export const longestWord = (s: string): string | undefined =>
  words(s).split(' ').filter((w) => w.length >= 3).sort((a, b) => b.length - a.length)[0];
