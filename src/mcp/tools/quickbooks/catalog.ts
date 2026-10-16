import { z } from 'zod';
import type { QbItem, QbItemType } from '@/core/contracts/quickbooks';
import { GuardrailError, ProviderError } from '@/core/errors';
import { companyField, FAN_OUT_NOTE, WRITE_DEADLINE_MS, checked, perCompany, qbTool, qbWrite, writeCompany } from './common';
import { longestWord, similarity, verdict } from './match';
import { isoDate, today } from './params';

const productOf = (i: QbItem) => ({
  id: i.Id ?? '',
  name: i.Name ?? '',
  type: i.Type ?? null,
  description: i.Description ?? null,
  sku: i.Sku ?? null,
  unit_price: i.UnitPrice ?? null,
  // Canadian companies mostly carry a sales tax code instead of a Taxable flag; neither is guessed.
  taxable: i.Taxable ?? null,
  sales_tax_code: i.SalesTaxCodeRef?.name ?? i.SalesTaxCodeRef?.value ?? null,
  quantity_on_hand: i.QtyOnHand ?? null,
});

export const searchProductsTool = qbTool({
  name: 'qbo_catalog_search_products',
  description:
    'PREFERRED tool for resolving products/services in invoice, estimate and other sales flows: use this, not qbo_accounting_get_product_service_list, whenever you need a product/service ID, price or taxable flag for a line item. ' +
    'Searches QuickBooks by product/service NAME (not the description field). Provide up to 20 search strings; each gets found, matches, best_match, requires_clarification and match_quality. ' +
    'If any item has found=false, call qbo_catalog_create_product for each missing item. If any has requires_clarification=true, show the candidates and ask the user which product they meant.' +
    FAN_OUT_NOTE,
  input: z.object({ descriptions: z.array(z.string()).max(20), account: companyField }),
  kind: 'lookup',
  async handler(input, ctx) {
    const terms = input.descriptions.map((d) => d.trim()).filter(Boolean);
    const name = 'qbo_catalog_search_products';
    const r = await perCompany(ctx, name, input.account, async (qb, _a, signal) => {
      const results = [];
      // One query at a time: Intuit limits concurrent requests per company.
      for (const term of terms) {
        if (signal.aborted) throw new ProviderError('timeout', 'QuickBooks request timed out.');
        let hits = await qb.findItems(term);
        const word = longestWord(term);
        if (hits.length === 0 && word && word !== term.toLowerCase()) hits = await qb.findItems(word);
        const v = verdict(hits.map((h) => ({ ...productOf(h), score: similarity(term, h.Name ?? '') })));
        results.push({ ...v, description_searched: term });
      }
      const matched = results.filter((x) => x.found).length;
      const clarify = results.some((x) => x.requires_clarification);
      return {
        status: 'success',
        error: null,
        meta: { descriptions_count: terms.length, matched_count: matched },
        data: {
          success: true,
          results,
          requires_clarification: clarify,
          message: `Found ${matched} of ${terms.length} searched.${matched < terms.length ? ' Create the ones with found=false.' : ''}${clarify ? ' Ask the user to choose where requires_clarification=true.' : ''}`,
        },
      };
    });
    return { companies: r.items, accountErrors: r.accountErrors };
  },
});

const TYPE_ALIASES: Record<string, QbItemType> = { SERVICE: 'Service', INVENTORY: 'Inventory', NON_INVENTORY: 'NonInventory', NONINVENTORY: 'NonInventory' };

const createProductInput = z.object({
  description: z.string().max(4000).nullable().default('').describe('Optional product description.'),
  inventory_start_date: z.string().nullable().default(null).describe('Inventory as-of date in YYYY-MM-DD format. Used for INVENTORY.'),
  name: z.string().min(1).max(100).describe('Product or service name. If the name is longer than 100 characters, summarize it to under 100 characters.'),
  product_type: z.string().default('SERVICE').describe('Product type: SERVICE, INVENTORY, or NON_INVENTORY.'),
  quantity_on_hand: z.number().nullable().default(null).describe('Initial inventory quantity. Required for INVENTORY products.'),
  sku: z.string().max(100).nullable().default(null).describe('Optional SKU (stock keeping unit) for the product.'),
  taxable: z.boolean().nullable().default(null).describe('Whether this product is taxable. Left to the company setting when omitted.'),
  unit_price: z.number().describe('Price per unit. Can be negative for discounts/credits.'),
});

export const createProductTool = qbTool({
  name: 'qbo_catalog_create_product',
  description:
    'Create a new product or service in QuickBooks Online on exactly one company (`account` is required when more than one is connected). Provide a name, type (SERVICE, INVENTORY or NON_INVENTORY), price and optional description and SKU. ' +
    'Returns the new product ID for invoice and estimate line items. If unit_price is not known, ask the user before calling. INVENTORY needs quantity_on_hand. ' +
    'It is attached to the company\'s own income account (and inventory and cost accounts for INVENTORY). `taxable` is sent only for a US company; for a Canadian company it is ignored with a note (tax codes are set per invoice line). No tax code is set. A name that already exists is refused by QuickBooks.',
  input: z.object({ input_data: createProductInput, account: companyField }),
  kind: 'write',
  async handler(input, ctx) {
    const tool = 'qbo_catalog_create_product';
    const d = input.input_data;
    const plan = await checked(ctx, tool, input.account, () => {
      const type = TYPE_ALIASES[d.product_type.trim().toUpperCase()];
      if (!type) throw new GuardrailError('product_type', 'product_type must be SERVICE, INVENTORY or NON_INVENTORY.');
      if (!Number.isFinite(d.unit_price)) throw new GuardrailError('unit_price', 'unit_price must be a number.');
      if (type === 'Inventory' && (d.quantity_on_hand === null || !Number.isFinite(d.quantity_on_hand) || d.quantity_on_hand < 0)) {
        throw new GuardrailError('quantity_on_hand', 'quantity_on_hand is required for INVENTORY products.');
      }
      return { type, start: type === 'Inventory' ? isoDate(d.inventory_start_date ?? today(), 'inventory_start_date') : undefined };
    });
    const account = await writeCompany(ctx, input.account);
    const notes: string[] = [];
    const item = await qbWrite(ctx, tool, account, (i: QbItem) => i.Id, async () => {
      const qb = ctx.adapters.quickbooks(ctx.quickbooksContext(account, AbortSignal.timeout(WRITE_DEADLINE_MS)));
      // Every company counts as Canadian unless CompanyInfo says US (or cannot be read); Canada has no item-level Taxable flag.
      let taxable = d.taxable;
      if (taxable !== null && (await qb.companyInfo().catch(() => undefined))?.Country !== 'US') {
        taxable = null;
        notes.push('taxable was ignored: in Canada, sales tax codes are set per line on invoices, not on the item.');
      }
      return qb.createItem({
        name: d.name.trim(),
        type: plan.type,
        unitPrice: d.unit_price,
        ...(d.description ? { description: d.description } : {}),
        ...(d.sku ? { sku: d.sku } : {}),
        ...(taxable !== null ? { taxable } : {}),
        ...(plan.type === 'Inventory' ? { quantityOnHand: d.quantity_on_hand!, inventoryStartDate: plan.start! } : {}),
      });
    });
    return { status: 'success', error: null, data: { success: true, product: productOf(item), ...(notes.length ? { notes } : {}) }, account: account.label, accountEmail: account.email };
  },
});
