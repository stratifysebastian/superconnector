import type { AnyToolDef } from '@/mcp/registry';
import { createEventTool, updateEventTool } from './writes';
import { getEventTool, listCalendarsTool, listEventsTool, searchEventsTool } from './reads';
import { suggestTimeTool } from './suggest_time';

export const calendarTools = (): AnyToolDef[] => [
  listCalendarsTool,
  listEventsTool,
  searchEventsTool,
  getEventTool,
  suggestTimeTool,
  createEventTool,
  updateEventTool,
] as AnyToolDef[];
