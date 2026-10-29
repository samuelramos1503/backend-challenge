import { WagerTransaction } from "../models/wager-transaction.entity";

export interface IWagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findPendingReferences(limit?: number): Promise<WagerTransaction[]>;
  save(transaction: WagerTransaction): Promise<void>;
}
