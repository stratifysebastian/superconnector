import { z } from 'zod';
import type { QbCustomer } from '@/core/contracts/quickbooks';
import { companyField, FAN_OUT_NOTE, perCompany, qbTool, qbWrite, writeCompany, checked } from './common';
import { similarity, verdict } from './match';

const customerOf = (c: QbCustomer) => ({
  id: c.Id ?? '',
  display_name: c.DisplayName ?? '',
  company_name: c.CompanyName ?? null,
  email: c.PrimaryEmailAddr?.Address ?? null,
  phone: c.PrimaryPhone?.FreeFormNumber ?? null,
});

export const searchCustomerTool = qbTool({
  name: 'qbo_contact_search_customer',
  description:
    'Search for customers in QuickBooks Online by name or email. Names match as "contains" and are ranked by similarity; an email that matches exactly counts as a full match. ' +
    'Returns customer IDs, display names, email addresses and a score needed to create or update invoices and estimates. If found=false, call qbo_contact_create_customer. ' +
    'If requires_clarification=true, present the candidates to the user and ask which customer they meant.' +
    FAN_OUT_NOTE,
  input: z.object({ customer_email: z.string().default(''), customer_name: z.string(), account: companyField }),
  kind: 'lookup',
  async handler(input, ctx) {
    const name = input.customer_name.trim();
    const email = input.customer_email.trim();
    const tool = 'qbo_contact_search_customer';
    const r = await perCompany(ctx, tool, input.account, async (qb) => {
      const candidates = name || email ? await qb.findCustomers({ ...(name ? { name } : {}), ...(email ? { email } : {}) }) : [];
      const scored = candidates.map((c) => ({
        ...customerOf(c),
        score: email && c.PrimaryEmailAddr?.Address?.toLowerCase() === email.toLowerCase() ? 1 : similarity(name, c.DisplayName ?? ''),
      }));
      const v = verdict(scored);
      return {
        status: 'success',
        error: null,
        meta: {},
        data: {
          ...v,
          total_candidates: candidates.length,
          message: v.found
            ? `Found ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}.${v.requires_clarification ? ' Ask the user which customer they meant.' : ''}`
            : 'No matching customer found. Create the customer if the user wants one.',
        },
      };
    });
    return { companies: r.items, accountErrors: r.accountErrors };
  },
});

const additional = z.object({
  billing_address: z.string().nullable().default(null).describe('Freeform billing address string (bill to address)'),
  email: z.email().nullable().default(null).describe('Email address (validated)'),
  phone_number: z.string().nullable().default(null).describe('Phone number string'),
  shipping_address: z.string().nullable().default(null).describe('Freeform shipping address string (ship to address)'),
});
const createCustomerInput = z.object({
  additional_params: additional.nullable().default(null).describe("Additional parameters. Supported fields: 'email' (validated), 'phone_number', 'billing_address', 'shipping_address'"),
  company_name: z.string().nullable().default(null).describe('Company name of customer (optional)'),
  display_name: z.string().min(1).describe('Display name of customer to create (required)'),
  first_name: z.string().nullable().default(null).describe('First name of customer (optional)'),
  last_name: z.string().nullable().default(null).describe('Last name of customer (optional)'),
});

export const createCustomerTool = qbTool({
  name: 'qbo_contact_create_customer',
  description:
    'Create a new customer in QuickBooks Online on exactly one company (`account` is required when more than one is connected). Provide the display name and optional contact details (email, phone, billing and shipping address as free text). ' +
    'Returns the new customer ID and details needed for creating invoices and estimates. Search first with qbo_contact_search_customer to avoid duplicates; QuickBooks refuses a display name that already exists.',
  input: z.object({ input_data: createCustomerInput, account: companyField }),
  kind: 'write',
  async handler(input, ctx) {
    const tool = 'qbo_contact_create_customer';
    const d = input.input_data;
    await checked(ctx, tool, input.account, () => undefined);
    const account = await writeCompany(ctx, input.account);
    const extra = d.additional_params;
    const created = await qbWrite(ctx, tool, account, (c: QbCustomer) => c.Id, () =>
      ctx.adapters.quickbooks(ctx.quickbooksContext(account)).createCustomer({
        displayName: d.display_name.trim(),
        ...(d.first_name ? { firstName: d.first_name } : {}),
        ...(d.last_name ? { lastName: d.last_name } : {}),
        ...(d.company_name ? { companyName: d.company_name } : {}),
        ...(extra?.email ? { email: extra.email } : {}),
        ...(extra?.phone_number ? { phone: extra.phone_number } : {}),
        ...(extra?.billing_address ? { billingAddress: extra.billing_address } : {}),
        ...(extra?.shipping_address ? { shippingAddress: extra.shipping_address } : {}),
      }),
    );
    return { status: 'success', error: null, data: { success: true, customer: customerOf(created) }, account: account.label, accountEmail: account.email };
  },
});
