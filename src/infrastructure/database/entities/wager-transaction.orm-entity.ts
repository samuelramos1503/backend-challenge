import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { FailureCode } from "../../../domain/models/failure-code.enum";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/models/wager-transaction.entity";

@Entity({ tableName: "wager_transactions" })
@Unique({ properties: ["providerId", "externalTransactionId"] })
@Unique({ properties: ["idempotencyKey"] })
@Index({ properties: ["walletId"] })
@Index({ properties: ["status"] })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "varchar", length: 100 })
  providerId!: string;

  @Property({ type: "varchar", length: 150 })
  externalTransactionId!: string;

  @Property({ type: "varchar", length: 255 })
  idempotencyKey!: string;

  @Property({ type: "varchar", length: 64 })
  payloadHash!: string;

  @Property({ type: "uuid" })
  walletId!: string;

  @Property({ type: "varchar", length: 100 })
  playerId!: string;

  @Property({ type: "varchar", length: 100 })
  roundId!: string;

  @Property({ type: "varchar", length: 100 })
  gameId!: string;

  @Property({ type: "varchar", length: 20 })
  kind!: WagerTransactionKind;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({ type: "varchar", length: 30 })
  status!: WagerTransactionStatus;

  @Property({ type: "varchar", length: 150, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: "uuid", nullable: true })
  referenceTransactionId?: string;

  @Property({ type: "varchar", length: 50, nullable: true })
  failureCode?: FailureCode;

  @Property({ type: "decimal", precision: 18, scale: 2, nullable: true })
  observedBalance?: string;

  @Property({ type: "int", default: 0 })
  retryAttempts: number = 0;

  @Property({ type: "timestamptz", nullable: true })
  nextRetryAt?: Date;

  @Property({ type: "timestamptz", nullable: true })
  processedAt?: Date;

  @Property({ type: "timestamptz" })
  createdAt: Date = new Date();
}
