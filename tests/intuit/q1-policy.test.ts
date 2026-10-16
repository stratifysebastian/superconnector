import { describe, expect, it, vi } from 'vitest';
import { GuardrailError, ProviderError } from '../../src/core/errors';
import { INTUIT_LIVE_HOST, INTUIT_RULES, checkIntuitRequest, companyPath } from '../../src/intuit/endpoints';
import { IntuitError, failureDetail, parseFault } from '../../src/intuit/errors';
import { createIntuitHttp } from '../../src/intuit/http';
import { accountsQuery, customersQuery, itemsQuery, qboString } from '../../src/intuit/query';
import { createLiveQuickBooksAdapter, customerBody, itemBody } from '../../src/intuit/quickbooks';
import type { LogEvent } from '../../src/core/contracts/tool';

const REALM = '9130350000';
const acct = { id: 'a', provider: 'intuit' as const, email: 'x@y.test', label: 'stratify-ca', orgClientId: 'o', priority: 0, connectedAt: '', status: 'active' as const, grantedScopes: [], realmId: REALM };

function setup(responses: Array<() => Response | Promise<Response>>) {
  const logs: LogEvent[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (..._a: [string, RequestInit]) => (queue.length > 1 ? queue.shift()! : queue[0]!)()); // eslint-disable-line @typescript-eslint/no-unused-vars
  const http = createIntuitHttp({
    getAccessToken: async () => 'tok',
    realmId: REALM,
    env: 'production',
    fetchImpl: fetchImpl as never,
    sleep: async () => undefined,
    random: () => 0.5,
    log: { info: (e) => void logs.push(e), warn: (e) => void logs.push(e), error: (e) => void logs.push(e) },
  });
  return { http, fetchImpl, logs };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const check = (over: Record<string, unknown>) =>
  checkIntuitRequest(INTUIT_RULES, { method: 'GET', host: INTUIT_LIVE_HOST, path: companyPath(REALM, 'query'), realmId: REALM, env: 'production', ...over } as never);

describe('query endpoint rule', () => {
  it('allows the query key only on /query, and only for a select on Item, Customer or Account', () => {
    expect(check({ query: { query: "select * from Item where Active = true" } }).ok).toBe(true);
    expect(check({ query: { query: "select Id, Name from Account where AccountType = 'Income'" } }).ok).toBe(true);
    for (const rest of [`companyinfo/${REALM}`, 'reports/BalanceSheet', 'reports/AgedReceivables', 'item', 'customer']) {
      for (const method of ['GET', 'POST']) {
        expect(check({ method, path: companyPath(REALM, rest), query: { query: 'select * from Item' }, body: {} }).ok).toBe(false);
      }
    }
  });

  it.each([
    ['another entity', 'select * from Invoice'],
    ['a payroll entity', 'select * from Employee'],
    ['not a select', "delete from Item where Id = '1'"],
    ['a raw statement before the select', "update Item set Name = 'x'; select * from Item"],
    ['no select at all', 'Item'],
    ['a newline smuggling a second statement', 'select * from Item\nselect * from Invoice'],
    ['an empty query', ''],
    ['an oversize query', `select * from Item where Name = '${'a'.repeat(2100)}'`],
  ])('refuses %s', (_n, query) => {
    expect(check({ query: { query } }).ok).toBe(false);
  });

  it('refuses other query keys on /query', () => {
    expect(check({ query: { query: 'select * from Item', minorversion: '1' } }).ok).toBe(false);
    expect(check({ query: { query: 'select * from Item', format: 'csv' } }).ok).toBe(false);
  });

  it('IntuitHttp sends the query text URL-encoded as the only caller key', async () => {
    const { http, fetchImpl } = setup([json({ QueryResponse: {} })]);
    await http.json({ method: 'GET', path: companyPath(REALM, 'query'), query: { query: "select * from Item where Name like '%a&b=c%'" } });
    const u = new URL(fetchImpl.mock.calls[0]![0]);
    expect([...u.searchParams.keys()].sort()).toEqual(['minorversion', 'query']);
    expect(u.searchParams.get('query')).toBe("select * from Item where Name like '%a&b=c%'");
  });
});

describe('query building and injection', () => {
  /** Everything outside quoted string literals: what a value could change if it escaped its quotes. */
  const skeleton = (q: string) => q.replace(/'(?:[^'\\]|\\.)*'/g, "'S'");
  const attacks = [
    "x' or Name like '%",
    "x\\' or Id != '",
    "\\",
    "'; select * from Employee --",
    "x'\nselect * from Invoice",
    "%' and Active = false and Name like '%",
    "a\u0000b\u001fc",
    "'''",
  ];

  it.each(attacks)('an item search for %j stays one literal', (attack) => {
    expect(skeleton(itemsQuery({ nameContains: attack }))).toBe("select * from Item where Active = true and Name like 'S' startposition 1 maxresults 1000");
  });
  it.each(attacks)('a customer search for %j stays one literal each for name and email', (attack) => {
    expect(skeleton(customersQuery({ nameContains: attack, email: attack }))).toBe("select * from Customer where Active = true and DisplayName like 'S' and PrimaryEmailAddr = 'S' maxresults 20");
  });
  it('escapes quotes and backslashes, drops control characters and the LIKE wildcard', () => {
    expect(qboString("O'Brien")).toBe("'O\\'Brien'");
    expect(qboString('a\\b')).toBe("'a\\\\b'");
    expect(qboString('50% off\n\tnow')).toBe("'50 off now'");
    expect(itemsQuery({ nameContains: "O'Brien" })).toContain("Name like '%O\\'Brien%'");
  });
  it('every built query passes the endpoint rule, and a hostile type never reaches the text', () => {
    for (const q of [itemsQuery({}), itemsQuery({ type: 'Inventory', nameContains: "x'" }), customersQuery({ nameContains: "x'", email: "a'b@c.d" }), accountsQuery('Income')]) {
      expect(check({ query: { query: q } }).ok).toBe(true);
    }
    expect(() => itemsQuery({ type: "Service' or Active = false --" as never })).toThrow();
  });
  it('the adapter has no way to send a raw query: tool-shaped input is only escaped values', async () => {
    const seen: string[] = [];
    const http = { json: vi.fn(async (r: { query?: { query?: string } }) => (seen.push(r.query!.query!), { QueryResponse: {} })) };
    const qb = createLiveQuickBooksAdapter({ account: acct, http: http as never, signal: new AbortController().signal });
    await qb.findItems("x' or Name like '%");
    await qb.findCustomers({ name: "a'", email: "b'@c.d" });
    expect(seen.map(skeleton)).toEqual([
      "select * from Item where Active = true and Name like 'S' startposition 1 maxresults 20",
      "select * from Customer where Active = true and DisplayName like 'S' maxresults 20",
      "select * from Customer where Active = true and PrimaryEmailAddr = 'S' maxresults 20",
    ]);
  });
});

describe('report rules', () => {
  const rest = (n: string) => companyPath(REALM, `reports/${n}`);
  const period = ['start_date', 'end_date', 'accounting_method', 'summarize_column_by'];
  it.each([
    ['BalanceSheet', period],
    ['ProfitAndLoss', period],
    ['CashFlow', period],
    ['CustomerSales', period],
    ['ItemSales', period],
    ['AgedReceivables', ['report_date']],
    ['AgedReceivableDetail', ['report_date']],
    ['AgedPayables', ['report_date']],
    ['AgedPayableDetail', ['report_date']],
  ])('%s allows exactly its parameters', (name, keys) => {
    const query = Object.fromEntries(keys.map((k) => [k, 'x']));
    expect(check({ path: rest(name), query }).ok).toBe(true);
    for (const bad of ['customer', 'vendor', 'columns', 'sort_order', 'query', 'minorversion', 'accounting_method2']) {
      expect(check({ path: rest(name), query: { [bad]: 'x' } }).ok).toBe(false);
    }
    for (const other of period.concat('report_date', 'date_macro').filter((k) => !keys.includes(k))) expect(check({ path: rest(name), query: { [other]: 'x' } }).ok).toBe(false);
  });
  it('denies a report that is not on the list and a POST to a report', () => {
    expect(check({ path: rest('GeneralLedger') }).ok).toBe(false);
    expect(check({ path: rest('TrialBalance') }).ok).toBe(false);
    expect(check({ method: 'POST', path: rest('BalanceSheet'), body: {} }).ok).toBe(false);
  });
});

describe('POST rules and transport', () => {
  const create = (rest: string, body: unknown) => check({ method: 'POST', path: companyPath(REALM, rest), body, query: {} });
  it('allows only the listed body keys on Item and Customer create', () => {
    expect(create('item', { Name: 'x', Type: 'Service', UnitPrice: 1, IncomeAccountRef: { value: '1' } }).ok).toBe(true);
    expect(create('customer', { DisplayName: 'x', PrimaryEmailAddr: { Address: 'a@b.test' } }).ok).toBe(true);
    for (const [rest, key] of [['item', 'Id'], ['item', 'SyncToken'], ['item', 'sparse'], ['item', 'TaxClassificationRef'], ['customer', 'Id'], ['customer', 'Notes'], ['customer', 'CurrencyRef']] as const) {
      expect(create(rest, { Name: 'x', DisplayName: 'x', [key]: 'v' }).ok).toBe(false);
    }
  });
  it('denies a body that is not a plain object, a body on a GET, and a POST with a query string', () => {
    expect(create('item', null).ok).toBe(false);
    expect(create('item', [1]).ok).toBe(false);
    expect(create('item', 'Name').ok).toBe(false);
    expect(check({ query: { query: 'select * from Item' }, body: {} }).ok).toBe(false);
    expect(check({ method: 'POST', path: companyPath(REALM, 'item'), body: { Name: 'x' }, query: { requestid: 'x' } }).ok).toBe(false);
  });
  it('denies POST/PUT/PATCH/DELETE anywhere else, including update and delete shapes of the allowed entities', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const rest of [`companyinfo/${REALM}`, 'invoice', 'item/5', 'customer/5', 'item?operation=delete', 'customer?operation=update', 'query', 'estimate', 'bill', 'payment']) {
        expect(check({ method, path: companyPath(REALM, rest), body: { Name: 'x' } }).ok).toBe(false);
      }
    }
  });

  it('sends the checked body as JSON with a content type', async () => {
    const { http, fetchImpl } = setup([json({ Customer: { Id: '9' } })]);
    await http.json({ method: 'POST', path: companyPath(REALM, 'customer'), body: { DisplayName: 'Zed' } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(new URL(url).pathname).toBe(`/v3/company/${REALM}/customer`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ DisplayName: 'Zed' });
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
  it('a body key outside the list never reaches fetch', async () => {
    const { http, fetchImpl } = setup([json({})]);
    await expect(http.json({ method: 'POST', path: companyPath(REALM, 'item'), body: { Name: 'x', Id: '1' } })).rejects.toBeInstanceOf(GuardrailError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['429', () => new Response('{}', { status: 429, headers: { 'retry-after': '1' } }), 'rate_limited'],
    ['500', () => new Response('{}', { status: 500 }), 'upstream_error'],
    ['503', () => new Response('{}', { status: 503 }), 'upstream_error'],
    ['401', () => new Response('{}', { status: 401 }), 'upstream_error'],
  ])('never retries a POST: %s is one request', async (_n, res, kind) => {
    const { http, fetchImpl } = setup([res]);
    const err = (await http.json({ method: 'POST', path: companyPath(REALM, 'item'), body: { Name: 'x' } }).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe(kind);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('a POST that times out or loses the connection is not retried and says the record may exist', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const http = createIntuitHttp({ getAccessToken: async () => 'tok', realmId: REALM, env: 'production', fetchImpl: fetchImpl as never });
    const err = (await http.json({ method: 'POST', path: companyPath(REALM, 'item'), body: { Name: 'x' } }).catch((e: unknown) => e)) as Error;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err.message).toContain('may or may not have been created');
  });
  it('a GET is still retried on 429', async () => {
    const { http, fetchImpl } = setup([() => new Response('{}', { status: 429 }), json({ QueryResponse: {} })]);
    await http.json({ method: 'GET', path: companyPath(REALM, 'query'), query: { query: 'select * from Item' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('the create bodies built by the adapter pass their own rules', () => {
    const item = itemBody({ name: 'Widget', type: 'Inventory', unitPrice: 5, quantityOnHand: 3, inventoryStartDate: '2026-01-01', taxable: true, sku: 's', description: 'd' }, { income: '1', asset: '2', expense: '3' });
    expect(create('item', item).ok).toBe(true);
    expect(itemBody({ name: 'S', type: 'Service', unitPrice: 5 }, { income: '1' })).not.toHaveProperty('Taxable');
    expect(create('customer', customerBody({ displayName: 'A', firstName: 'b', lastName: 'c', companyName: 'd', email: 'e@f.test', phone: '1', billingAddress: 'x', shippingAddress: 'y' })).ok).toBe(true);
  });
});

describe('failures: Fault handling, plain messages, nothing retried', () => {
  const fault = (code: string, Message: string, type = 'ValidationFault', Detail = 'Secret Customer Inc owes $99,999') => ({ Fault: { Error: [{ Message, Detail, code }], type }, time: 'now' });
  const run = async (res: () => Response, path = 'customer', method: 'GET' | 'POST' = 'POST') => {
    const s = setup([res]);
    const req = method === 'GET' ? { query: { query: 'select * from Item' } } : { body: path === 'item' ? { Name: 'x' } : { DisplayName: 'x' } };
    const err = (await s.http.json({ method, path: companyPath(REALM, path), ...req }).catch((e: unknown) => e)) as IntuitError;
    return { err, ...s };
  };

  it('a 400 validation Fault becomes what failed, Intuit\'s error name and code; Detail is never used', async () => {
    const { err, fetchImpl, logs } = await run(json(fault('6240', 'Duplicate Name Exists Error'), 400, { intuit_tid: 'tid-123' }));
    expect(err.message).toBe('QuickBooks could not create the customer: Duplicate Name Exists Error (error code 6240).');
    expect(err.message).not.toContain('plan');
    expect(err.message).not.toContain('Secret');
    expect(err).toMatchObject({ status: 400, intuitCode: '6240', intuitName: 'Duplicate Name Exists Error', tid: 'tid-123' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs)).not.toContain('Secret');
    expect(JSON.stringify(logs)).toContain('tid-123');
  });
  it('a feature or permission error says it may not be available on the plan', async () => {
    for (const body of [fault('5020', 'Permission Denied Error'), fault('120', 'Authorization Failure', 'AuthorizationFault'), fault('6000', 'Feature Not Supported')]) {
      const { err, fetchImpl } = await run(json(body, 400));
      expect(err.message).toContain('This may not be available on your QuickBooks plan.');
      expect(err.message).toMatch(/^QuickBooks could not create the customer: /);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it('the wrapped "message=Name; errorCode=..." form is read, a hostile one is dropped', async () => {
    expect((await run(json(fault('2010', 'message=Request has invalid or unsupported property; errorCode=2010; statusCode=400'), 400))).err.message).toContain('Request has invalid or unsupported property (error code 2010)');
    const hostile = (await run(json(fault('2010', "x'; select * from Employee <script>"), 400))).err;
    expect(hostile.message).toBe('QuickBooks could not create the customer: Intuit error 2010 (error code 2010).');
  });
  it.each([
    ['not JSON', () => new Response('<html>Bad Request</html>', { status: 400 })],
    ['an empty body', () => new Response('', { status: 400 })],
    ['JSON without a Fault', () => new Response(JSON.stringify({ error: 'nope', detail: 'Secret' }), { status: 400 })],
    ['a Fault with no Error list', () => new Response(JSON.stringify({ Fault: {} }), { status: 400 })],
    ['a Fault with an Error that is not an object', () => new Response(JSON.stringify({ Fault: { Error: ['boom'] } }), { status: 400 })],
    ['a code that is not digits', () => new Response(JSON.stringify({ Fault: { Error: [{ code: '12 OR 1=1', Message: 'Bad' }] } }), { status: 400 })],
    ['a body that is an array', () => new Response('[]', { status: 400 })],
  ])('malformed error body (%s) still gives one plain message and one request', async (_n, res) => {
    const { err, fetchImpl } = await run(res, 'item');
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/^QuickBooks could not create the product or service: /);
    expect(err.message).not.toContain('Secret');
    expect(err.message).not.toContain('OR 1=1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('a malformed success body is an upstream error, not a crash', async () => {
    const { err } = await run(() => new Response('not json', { status: 200 }), 'query', 'GET');
    expect(err.kind).toBe('upstream_error');
  });
  it('a query parse error on a GET is reported once, not retried', async () => {
    const { err, fetchImpl } = await run(json(fault('4000', 'Query Parser Error'), 400), 'query', 'GET');
    expect(err.message).toBe('QuickBooks could not look up records: Intuit error 4000 (error code 4000).');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('failureDetail is short and holds only status, code, name and tid', () => {
    const e = new IntuitError('upstream_error', 'm', 400, '6240', 'Duplicate Name Exists Error', 'tid-1');
    expect(failureDetail(e)).toBe('http 400; code 6240; Duplicate Name Exists Error; tid tid-1');
    expect(failureDetail(new ProviderError('timeout', 'm'))).toBe('timeout');
    expect(failureDetail(new GuardrailError('rule/x', 'm with Secret'))).toBe('blocked rule/x');
    expect(failureDetail(new Error('Secret name'))).toBe('Error');
    expect(failureDetail(new IntuitError('upstream_error', 'm', 500, undefined, 'x'.repeat(500), 't'.repeat(500))).length).toBeLessThanOrEqual(200);
  });
  it('parseFault keeps only code, name and type', () => {
    expect(parseFault(fault('6240', 'Duplicate Name Exists Error'))).toEqual({ code: '6240', name: 'Duplicate Name Exists Error', type: 'ValidationFault' });
    expect(parseFault(null)).toEqual({});
    expect(parseFault({ Fault: { Error: [{ Detail: 'Secret' }] } })).toEqual({});
  });
});
