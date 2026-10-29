import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "inbox_messages" })
export class InboxMessageOrmEntity {
  @PrimaryKey({ type: "varchar", length: 100 })
  consumerName!: string;

  @PrimaryKey({ type: "varchar", length: 255 })
  messageId!: string;

  @Property({ type: "varchar", length: 64 })
  payloadHash!: string;

  @Property({ type: "timestamptz" })
  receivedAt: Date = new Date();

  @Property({ type: "timestamptz", nullable: true })
  processedAt?: Date;
}
