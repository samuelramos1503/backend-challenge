import { Check, Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { LedgerDirection } from "../../../domain/models/wallet-ledger-entry.entity";

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({ properties: ["walletId", "transactionId"] })
@Index({ properties: ["walletId", "createdAt", "id"] })
@Check({
  expression:
    "(direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount)",
})
export class WalletLedgerEntryOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "uuid" })
  walletId!: string;

  @Property({ type: "uuid" })
  transactionId!: string;

  @Property({ type: "varchar", length: 10 })
  direction!: LedgerDirection;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  balanceBefore!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property({ type: "timestamptz" })
  createdAt: Date = new Date();
}
