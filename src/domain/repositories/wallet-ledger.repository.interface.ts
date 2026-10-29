import { Money } from "../models/money.vo";
import { WalletLedgerEntry } from "../models/wallet-ledger-entry.entity";

export interface LedgerCursorPaginationOptions {
  cursor?: string;
  limit: number;
}

export interface LedgerCursorPaginationResult {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface LedgerReconciliationSummary {
  walletId: string;
  totalCredit: Money;
  totalDebit: Money;
  calculatedBalance: Money;
  totalEntries: number;
}

export interface IWalletLedgerRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
  findByWalletId(walletId: string, options: LedgerCursorPaginationOptions): Promise<LedgerCursorPaginationResult>;
  reconcileWallet(walletId: string, currency: string): Promise<LedgerReconciliationSummary>;
}
