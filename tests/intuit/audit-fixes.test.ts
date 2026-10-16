import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QbReport } from '../../src/core/contracts/quickbooks';
import type { ToolContext } from '../../src/core/contracts/tool';
import { GuardrailError, ProviderError } from '../../src/core/errors';
import { INTUIT_LIVE_HOST, INTUIT_RULES, checkIntuitRequest, companyPath } from '../../src/intuit/endpoints';
import { faultMessage, parseFault } from '../../src/intuit/errors';
import { createIntuitHttp } from '../../src/intuit/http';
import { createLiveQuickBooksAdapter } from '../../src/intuit/quickbooks';
import { prepare, toText } from '../../src/intuit/reports/render';
import { qbWrite } from '../../src/mcp/tools/quickbooks/common';
import { periodParams } from '../../src/mcp/tools/quickbooks/params';

const REALM = '9130350000';
const acct = { id: 'a', provider: 'intuit' as const, email: 'x@y.test', label: 'stratify-ca', orgClientId: 'o', priority: 0, connectedAt: '', status: 'active' as const, grantedScopes: [], realmId: REALM };
const res = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

type Fetch = (url: string, init: RequestInit) => Response | Promise<Response>;
function mk(fetchImpl: Fetch, signal?: AbortSignal, extra: Partial<Parameters<typeof createIntuitHttp>[0]> = {}) {
  const f = vi.fn(async (url: string, init: RequestInit) => fetchImpl(url, init));
  const http = createIntuitHttp({ getAccessToken: async () => 'tok', realmId: REALM, env: 'production', fetchImpl: f as never, random: () => 0.5, ...(signal ? { signal } : {}), ...extra });
  return { http, f };
}
const get = (http: ReturnType<typeof mk>['http']) => http.json({ method: 'GET', path: companyPath(REALM, `companyinfo/${REALM}`) });
const post = (http: ReturnType<typeof mk>['http']) =>
  http.json({ method: 'POST', path: companyPath(REALM, 'customer'), body: { DisplayName: 'x' } });

afterEach(() => vi.restoreAllMocks());

describe('M1: inventory and income accounts', () => {
  const adapterWith = (accounts: Record<string, object[]>) => {
    const json = vi.fn(async (req: { method: string; query?: { query: string } }) => {
      if (req.method === 'POST') return { Item: { Id: '1', Name: 'N' } };
      const kind = /AccountType = '([^']+)'/.exec(req.query!.query)![1]!;
      return { QueryResponse: { Account: accounts[kind] ?? [] } };
    });
    const qb = createLiveQuickBooksAdapter({ account: acct, http: { json } as never, signal: new AbortController().signal });
    const posts = () => json.mock.calls.filter((c) => c[0].method === 'POST');
    return { qb, posts };
  };
  const inv = { name: 'N', type: 'Inventory' as const, unitPrice: 1, quantityOnHand: 1, inventoryStartDate: '2026-01-01' };
  const income = [{ Id: '10', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome' }];

  it('refuses an inventory item when there is no exact Inventory asset account, and sends nothing', async () => {
    const { qb, posts } = adapterWith({ Income: income, 'Other Current Asset': [{ Id: '77', AccountSubType: 'PrepaidExpenses' }], 'Cost of Goods Sold': [{ Id: '5', AccountSubType: 'SuppliesMaterialsCogs' }] });
    await expect(qb.createItem(inv)).rejects.toThrow(/no Inventory asset account.*Set one up in QuickBooks/);
    await expect(qb.createItem(inv)).rejects.toBeInstanceOf(ProviderError);
    expect(posts()).toHaveLength(0);
  });
  it('refuses an inventory item when there is no exact cost of goods sold account', async () => {
    const { qb, posts } = adapterWith({ Income: income, 'Other Current Asset': [{ Id: '6', AccountSubType: 'Inventory' }], 'Cost of Goods Sold': [{ Id: '88', AccountSubType: 'EquipmentRental' }] });
    await expect(qb.createItem(inv)).rejects.toThrow(/no Cost of Goods Sold account/);
    expect(posts()).toHaveLength(0);
  });
  it('uses the exact sub-types when present', async () => {
    const { qb, posts } = adapterWith({
      Income: [{ Id: '9', AccountType: 'Income', AccountSubType: 'Other' }, ...income],
      'Other Current Asset': [{ Id: '77', AccountSubType: 'PrepaidExpenses' }, { Id: '6', AccountSubType: 'Inventory' }],
      'Cost of Goods Sold': [{ Id: '88', AccountSubType: 'EquipmentRental' }, { Id: '5', AccountSubType: 'SuppliesMaterialsCogs' }],
    });
    await qb.createItem(inv);
    const body = (posts()[0]![0] as unknown as { body: Record<string, { value: string }> }).body;
    expect([body.IncomeAccountRef!.value, body.AssetAccountRef!.value, body.ExpenseAccountRef!.value]).toEqual(['10', '6', '5']);
  });
  it('income falls back to another Income-type account only, never an arbitrary one', async () => {
    const other = adapterWith({ Income: [{ Id: '3', AccountType: 'Income', AccountSubType: 'OtherPrimaryIncome' }] });
    await other.qb.createItem({ name: 'S', type: 'Service', unitPrice: 1 });
    expect((other.posts()[0]![0] as unknown as { body: { IncomeAccountRef: { value: string } } }).body.IncomeAccountRef.value).toBe('3');
    const wrong = adapterWith({ Income: [{ Id: '4', AccountType: 'Other Income', AccountSubType: 'OtherMiscellaneousIncome' }] });
    await expect(wrong.qb.createItem({ name: 'S', type: 'Service', unitPrice: 1 })).rejects.toThrow(/no income account/);
    expect(wrong.posts()).toHaveLength(0);
  });
});

describe('M2: cancellation and deadlines', () => {
  it('a GET retry never starts once the signal is aborted', async () => {
    const ac = new AbortController();
    const { http, f } = mk(() => (ac.abort(), res({}, 500)), ac.signal, { sleep: async () => undefined });
    await expect(get(http)).rejects.toMatchObject({ kind: 'timeout' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('the backoff sleep is cut short by an abort', async () => {
    const ac = new AbortController();
    const { http, f } = mk(() => res({}, 503, { 'retry-after': '8' }), ac.signal);
    setTimeout(() => ac.abort(), 30);
    const started = Date.now();
    await expect(get(http)).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('an in-flight GET is aborted with the signal', async () => {
    const ac = new AbortController();
    const slow: Fetch = (_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const { http } = mk(slow, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(get(http)).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('total GET retry time is capped', async () => {
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const { http, f } = mk(() => ((t += 31_000), res({}, 500)), undefined, { sleep: async () => undefined });
    await expect(get(http)).rejects.toMatchObject({ kind: 'upstream_error' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a POST is not sent after the deadline, and says nothing was created', async () => {
    const ac = new AbortController();
    ac.abort();
    const { http, f } = mk(() => res({ Customer: {} }), ac.signal);
    await expect(post(http)).rejects.toThrow(/not sent; nothing was created/);
    expect(f).not.toHaveBeenCalled();
  });
  it('a POST in flight is not aborted by the deadline, so its result is never hidden', async () => {
    const ac = new AbortController();
    const { http } = mk((_u, init) => (ac.abort(), expect(init.signal!.aborted).toBe(false), res({ Customer: { Id: '1' } })), ac.signal);
    await expect(post(http)).resolves.toEqual({ Customer: { Id: '1' } });
  });
  it('a POST that fails keeps the "may or may not have been created" message', async () => {
    const { http } = mk(() => Promise.reject(new Error('net')));
    await expect(post(http)).rejects.toThrow(/may or may not have been created/);
  });
  it('a create whose lookups used up the deadline sends no POST', async () => {
    const ac = new AbortController();
    const { http, f } = mk((url) => (url.includes('/query') ? (ac.abort(), res({ QueryResponse: { Account: [{ Id: '10', AccountType: 'Income', AccountSubType: 'ServiceFeeIncome' }] } })) : res({ Item: { Id: '1' } })), ac.signal);
    const qb = createLiveQuickBooksAdapter({ account: acct, http, signal: ac.signal });
    await expect(qb.createItem({ name: 'S', type: 'Service', unitPrice: 1 })).rejects.toThrow(/nothing was created/);
    expect(f.mock.calls.filter((c) => c[1].method === 'POST')).toHaveLength(0);
  });
  it('listItems stops paging when the signal is aborted', async () => {
    const ac = new AbortController();
    const json = vi.fn(async () => (ac.abort(), { QueryResponse: { Item: Array.from({ length: 1000 }, () => ({})) } }));
    const qb = createLiveQuickBooksAdapter({ account: acct, http: { json } as never, signal: ac.signal });
    await expect(qb.listItems()).rejects.toMatchObject({ kind: 'timeout' });
    expect(json).toHaveBeenCalledTimes(1);
  });
});

describe('L1: only known Intuit titles survive', () => {
  const fault = (Message: string) => ({ Fault: { type: 'ValidationFault', Error: [{ code: '6240', Message }] } });
  it('a name-bearing message becomes "Intuit error" plus the code', () => {
    const f = parseFault(fault('Customer Jane Smith could not be saved'));
    expect(f.name).toBe('Intuit error 6240');
    expect(faultMessage('create the customer', 400, f)).not.toContain('Jane');
  });
  it('known titles pass, also in the wrapped form', () => {
    expect(parseFault(fault('Duplicate Name Exists Error')).name).toBe('Duplicate Name Exists Error');
    expect(parseFault(fault('message=Stale Object Error; errorCode=5010')).name).toBe('Stale Object Error');
  });
});

describe('L2: query shape', () => {
  const ok = (query: string) => checkIntuitRequest(INTUIT_RULES, { method: 'GET', host: INTUIT_LIVE_HOST, path: companyPath(REALM, 'query'), query: { query }, realmId: REALM, env: 'production' } as never).ok;
  it('rejects a second from and any subselect, in any case', () => {
    expect(ok('select * from Invoice from Item')).toBe(false);
    expect(ok('select * from Item from Item')).toBe(false);
    expect(ok('select * from Item where Id in (select Id from Invoice)')).toBe(false);
    expect(ok('select * from Item where Id in (SELECT Id FROM Item)')).toBe(false);
    expect(ok('select * from Item where Id in ( select Id from Item)')).toBe(false);
  });
  it('still allows our own queries, including a searched word like "from" or "(select"', () => {
    expect(ok("select * from Item where Active = true and Name like '%from scratch%' startposition 1 maxresults 20")).toBe(true);
    expect(ok("select * from Item where Name like '%(select x from y)%'")).toBe(true);
    expect(ok("select * from Item where Name like '%a\\' from b%'")).toBe(true);
  });
});

describe('L3 and L4', () => {
  it('a POST that returned 200 with an unreadable body says the record may exist', async () => {
    const { http } = mk(() => res('not json'));
    await expect(post(http)).rejects.toThrow(/may have been created; check QuickBooks before trying again/);
    const g = mk(() => res('not json'));
    await expect(get(g.http)).rejects.not.toThrow(/may have been created/);
  });
  it('a failed success-audit write does not make a created record look failed', async () => {
    const ctx = { store: { audit: { write: vi.fn().mockRejectedValue(new Error('db down')) } } } as unknown as ToolContext;
    await expect(qbWrite(ctx, 'tool', acct, (o: { id: string }) => o.id, async () => ({ id: '5' }))).resolves.toEqual({ id: '5' });
  });
});

describe('L6: explicit dates in Toronto calendar terms', () => {
  const range = (macro: string, iso: string) => {
    const p = periodParams({ date_range: macro }, { macro: 'THIS_MONTH' }, new Date(iso)).params;
    expect(p).not.toHaveProperty('date_macro');
    return [p.start_date, p.end_date];
  };
  it('around the March DST change (Sunday 8 March 2026)', () => {
    expect(range('TODAY', '2026-03-09T03:59:00Z')).toEqual(['2026-03-08', '2026-03-08']); // 23:59 EDT, still the 8th
    expect(range('TODAY', '2026-03-09T04:00:00Z')).toEqual(['2026-03-09', '2026-03-09']);
    expect(range('THIS_WEEK', '2026-03-08T12:00:00Z')).toEqual(['2026-03-02', '2026-03-08']);
    expect(range('THIS_WEEK_TO_DATE', '2026-03-09T04:00:00Z')).toEqual(['2026-03-09', '2026-03-09']);
    expect(range('LAST_WEEK', '2026-03-08T12:00:00Z')).toEqual(['2026-02-23', '2026-03-01']);
    expect(range('THIS_QUARTER', '2026-03-08T12:00:00Z')).toEqual(['2026-01-01', '2026-03-31']);
    expect(range('LAST_12_MONTHS', '2026-03-08T12:00:00Z')).toEqual(['2025-03-08', '2026-03-08']);
  });
  it('around the November DST change (Sunday 1 November 2026)', () => {
    expect(range('TODAY', '2026-11-01T05:30:00Z')).toEqual(['2026-11-01', '2026-11-01']);
    expect(range('TODAY', '2026-11-02T04:59:00Z')).toEqual(['2026-11-01', '2026-11-01']); // 23:59 EST
    expect(range('LAST_30_DAYS', '2026-11-01T12:00:00Z')).toEqual(['2026-10-02', '2026-11-01']);
    expect(range('THIS_MONTH', '2026-11-01T12:00:00Z')).toEqual(['2026-11-01', '2026-11-30']);
    expect(range('THIS_QUARTER_TO_DATE', '2026-11-01T12:00:00Z')).toEqual(['2026-10-01', '2026-11-01']);
  });
  it('at year end, Toronto time decides the year', () => {
    expect(range('THIS_YEAR', '2026-01-01T04:59:00Z')).toEqual(['2025-01-01', '2025-12-31']); // 23:59 on 31 Dec
    expect(range('THIS_YEAR', '2026-01-01T05:00:00Z')).toEqual(['2026-01-01', '2026-12-31']);
    expect(range('THIS_YEAR_TO_DATE', '2026-01-01T04:59:00Z')).toEqual(['2025-01-01', '2025-12-31']);
    expect(range('LAST_YEAR', '2026-01-01T05:00:00Z')).toEqual(['2025-01-01', '2025-12-31']);
    expect(range('LAST_QUARTER', '2026-01-01T05:00:00Z')).toEqual(['2025-10-01', '2025-12-31']);
    expect(range('LAST_MONTH', '2026-01-15T12:00:00Z')).toEqual(['2025-12-01', '2025-12-31']);
    expect(range('LAST_YEAR_TO_DATE', '2028-02-29T15:00:00Z')).toEqual(['2027-01-01', '2027-02-28']);
  });
  it('quarters and months are calendar ones', () => {
    expect(range('THIS_QUARTER', '2026-10-16T16:00:00Z')).toEqual(['2026-10-01', '2026-12-31']);
    expect(range('LAST_QUARTER', '2026-05-16T16:00:00Z')).toEqual(['2026-01-01', '2026-03-31']);
    expect(range('THIS_MONTH', '2028-02-10T16:00:00Z')).toEqual(['2028-02-01', '2028-02-29']);
  });
  it('ALL is refused, and a lone start or end gets a note', () => {
    expect(() => periodParams({ date_range: 'ALL' }, { macro: 'THIS_YEAR' })).toThrow(GuardrailError);
    const p = periodParams({ end_date: '2026-02-01' }, { macro: 'THIS_YEAR' }, new Date('2026-10-16T16:00:00Z'));
    expect(p.notes[0]).toMatch(/end_date was given, so it was ignored/);
    expect(p.params).toMatchObject({ start_date: '2026-01-01', end_date: '2026-12-31' });
  });
});

describe('I2: backticks in P&L labels', () => {
  it('cannot close the fenced block', () => {
    const raw = readFileSync('fixtures/quickbooks/stratify-ca/profit_loss.json', 'utf8').replaceAll('Consulting Services', 'Evil ``` Services');
    const t = toText(prepare('ProfitAndLoss', JSON.parse(raw) as QbReport, { company: 'C', requestedMethod: 'accrual' }));
    expect(t).toContain("Evil ''' Services");
    expect(t.match(/```/g)).toHaveLength(2);
  });
});
