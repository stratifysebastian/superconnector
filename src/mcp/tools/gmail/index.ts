import type { AnyToolDef } from '@/mcp/registry';
import { getDraftTool, getMessageTool, getThreadTool, listDraftsTool, listLabelsTool, searchThreadsTool } from './reads';
import { sendSelfReportTool } from './send_self_report';
import { createDraftTool, labelAndSpamTools, updateDraftTool } from './writes';

export const gmailTools = (): AnyToolDef[] => [
  searchThreadsTool,
  getThreadTool,
  getMessageTool,
  listDraftsTool,
  getDraftTool,
  listLabelsTool,
  createDraftTool,
  updateDraftTool,
  ...labelAndSpamTools(),
  sendSelfReportTool,
];
