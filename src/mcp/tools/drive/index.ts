import type { AnyToolDef } from '@/mcp/registry';
import { downloadFileTool, getMetadataTool, getPermissionsTool, listRecentTool, readFileTool, searchFilesTool } from './reads';
import { copyFileTool, createFileTool, updateFileTool } from './writes';

export const driveTools = (): AnyToolDef[] => [
  searchFilesTool,
  listRecentTool,
  getMetadataTool,
  getPermissionsTool,
  readFileTool,
  downloadFileTool,
  createFileTool,
  copyFileTool,
  updateFileTool,
];
