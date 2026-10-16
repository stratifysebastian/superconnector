import { CALENDAR_RULES } from './calendar';
import type { EndpointRule } from './policy';

/**
 * Every Google endpoint an adapter may call. Deny by default: a request that matches no row is rejected.
 * Empty in Phase 0. Each phase adds its rows in its own file (calendar.ts, gmail.ts, ...) and spreads them here.
 */
export const ENDPOINT_RULES: EndpointRule[] = [...CALENDAR_RULES];

export type { EndpointRule } from './policy';
export { checkRequest } from './policy';
export * from './urls';
