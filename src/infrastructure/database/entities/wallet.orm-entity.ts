import { Check, Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";

@Entity({ tableName: "wallets" })
@Unique({ properties: ["playerId", "currency"] })
@Check({ expression: "balance >= 0" })
export class WalletOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "varchar", length: 100 })
  playerId!: string;

  @Property({ type: "varchar", length: 3 })
  currency!: string;

  @Property({ type: "decimal", precision: 18, scale: 2 })
  balance!: string;

  @Property({ type: "bigint", default: "1" })
  version!: number;

  @Property({ type: "timestamptz" })
  createdAt: Date = new Date();

  @Property({ type: "timestamptz", onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
