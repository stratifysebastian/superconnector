import type { AnyToolDef } from '@/mcp/registry';
import { createProductTool, searchProductsTool } from './catalog';
import { companyInfoTool } from './company';
import { createCustomerTool, searchCustomerTool } from './contacts';
import { productServiceListTool } from './products';
import { reportTools } from './reports';

export const quickbooksTools = (): AnyToolDef[] => [
  companyInfoTool,
  ...reportTools(),
  productServiceListTool,
  searchProductsTool,
  createProductTool,
  searchCustomerTool,
  createCustomerTool,
];
