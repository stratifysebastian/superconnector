/**
 * The complete allowlist of registered MCP tools. A tool that is not named here must not be registered, and every
 * name here must be registered: tests/contract/enabled.test.ts compares this list with the real registry exactly.
 * Each phase adds its tool names here in the same change that registers them.
 */
export const ENABLED_TOOL_NAMES: readonly string[] = ['list_accounts'];
