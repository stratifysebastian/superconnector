import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('next.config security headers', () => {
  it('sends the hardened header set on every path', async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((r) => r.source === '/:path*');
    expect(rule).toBeDefined();
    const h = Object.fromEntries(rule!.headers.map((x) => [x.key, x.value]));
    expect(h).toEqual({
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    });
  });

  it('keeps poweredByHeader off', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
