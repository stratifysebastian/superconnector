import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/store/memory';
import { fakeCipher, runStoreConformance } from './conformance';

runStoreConformance('MemoryStore', () => {
  const store = createMemoryStore(fakeCipher);
  return { store, dump: () => store._dump() };
});

describe('MemoryStore audit', () => {
  it('stores fields, a timestamp, and truncates detail to 200 chars', async () => {
    const store = createMemoryStore(fakeCipher);
    await store.audit.write({ tool: 't', account: 'prime', targetId: 'id1', outcome: 'error', detail: 'y'.repeat(500) });
    const { audit } = store._dump() as { audit: { at: string; tool: string; account: string; targetId: string; outcome: string; detail: string }[] };
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: 't', account: 'prime', targetId: 'id1', outcome: 'error' });
    expect(audit[0]?.detail).toHaveLength(200);
    expect(Number.isNaN(Date.parse(audit[0]?.at ?? ''))).toBe(false);
  });
});
