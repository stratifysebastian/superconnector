import { describe, expect, it } from 'vitest';
import { getToolDefs } from '@/mcp/registry';
import { ENABLED_TOOL_NAMES } from './enabled';
import { EXCLUDED_TOOL_NAMES, assertNoExcludedTools } from './excluded';

describe('enabled-tool allowlist', () => {
  const registered = getToolDefs('https://example.test').map((d) => d.name);

  it('the real registry registers exactly the enabled tools', () => {
    expect([...registered].sort()).toEqual([...ENABLED_TOOL_NAMES].sort());
  });

  it('has no duplicates', () => {
    expect(new Set(ENABLED_TOOL_NAMES).size).toBe(ENABLED_TOOL_NAMES.length);
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('does not intersect the excluded tool names', () => {
    const excluded = new Set(EXCLUDED_TOOL_NAMES);
    expect(ENABLED_TOOL_NAMES.filter((n) => excluded.has(n))).toEqual([]);
    expect(() => assertNoExcludedTools(registered)).not.toThrow();
  });

  it('catches an unlisted tool and a missing tool', () => {
    expect([...registered, 'sneaky_tool'].sort()).not.toEqual([...ENABLED_TOOL_NAMES].sort());
    expect(registered.slice(1).sort()).not.toEqual([...ENABLED_TOOL_NAMES].sort());
  });
});
