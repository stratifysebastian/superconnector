import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const cache = new Map<string, unknown>();

function safe(seg: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(seg) || seg.includes('..')) throw new Error(`Invalid fixture path segment: ${seg}`);
  return seg;
}

/** Reads fixtures/<product>/<account>/<name>.json from the repo root (cached). */
export function loadFixture<T>(product: string, account: string, name: string): T {
  const file = path.join(process.cwd(), 'fixtures', safe(product), safe(account), `${safe(name)}.json`);
  if (cache.has(file)) return cache.get(file) as T;
  if (!existsSync(file)) throw new Error(`Mock fixture not found: ${file}`);
  const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  cache.set(file, data);
  return data as T;
}

export function clearFixtureCache(): void {
  cache.clear();
}
