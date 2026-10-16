import type { Provider } from './contracts/account';
import type { FanOutEngine } from './contracts/fanout';
import type { ToolContext, ToolStore } from './contracts/tool';

/**
 * Provider scoping, enforced once for every tool. The registry hands each handler `scopeToolContext(ctx, provider)`,
 * so `ctx.store.accounts.list()` and every `ctx.fanout` call only ever see accounts of the tool's own provider.
 * A Google tool cannot reach a QuickBooks company, and the reverse, whatever the tool's code does.
 */
export function scopeStore(store: ToolStore, provider: Provider): ToolStore {
  // No tool uses store.tokens or store.orgClients, so they are not handed out at all.
  return {
    audit: store.audit,
    accounts: { ...store.accounts, list: async () => (await store.accounts.list()).filter((a) => a.provider === provider) },
  };
}

export function scopeFanout(fanout: FanOutEngine, provider: Provider): FanOutEngine {
  return {
    read: (spec) => fanout.read({ ...spec, provider }),
    lookup: (selector, fn) => fanout.lookup(selector, fn, provider),
    resolveWriteAccount: (selector, fallback) => fanout.resolveWriteAccount(selector, fallback, provider),
  };
}

export function scopeToolContext(ctx: ToolContext, provider: Provider): ToolContext {
  return {
    adapters: ctx.adapters,
    log: ctx.log,
    store: scopeStore(ctx.store, provider),
    fanout: scopeFanout(ctx.fanout, provider),
    // A tool gets only its own provider's context builder.
    adapterContext: (account, signal) => {
      if (account.provider !== provider) throw new Error('Account belongs to a different provider');
      return ctx.adapterContext(account, signal);
    },
    quickbooksContext: (account, signal) => {
      if (account.provider !== provider) throw new Error('Account belongs to a different provider');
      return ctx.quickbooksContext(account, signal);
    },
  };
}
