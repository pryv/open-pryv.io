/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

type StoreTransactionLike = { exec: (func: () => unknown | Promise<unknown>) => Promise<unknown> };
type DataStoreLike = { newTransaction?: () => Promise<StoreTransactionLike> };
type MallLike = { storesById: Map<string, DataStoreLike> };

class MallTransaction {
  mall: MallLike;
  storeTransactions: Map<string, StoreTransactionLike>;

  constructor (mall: MallLike) {
    this.mall = mall;
    this.storeTransactions = new Map();
  }

  async getStoreTransaction (storeId: string): Promise<StoreTransactionLike | undefined> {
    if (this.storeTransactions.has(storeId)) {
      return this.storeTransactions.get(storeId);
    }
    const store = this.mall.storesById.get(storeId);
    // stubbing transaction when not supported (not yet documented in DataStore)
    if (store!.newTransaction == null) {
      return new StoreTransactionStub();
    }
    const transaction = await store!.newTransaction();
    this.storeTransactions.set(storeId, transaction);
    return transaction;
  }
}

export default MallTransaction;
export { MallTransaction };

class StoreTransactionStub {
  async exec (func: () => unknown | Promise<unknown>): Promise<unknown> { return await func(); }
}
