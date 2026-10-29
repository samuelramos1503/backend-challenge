import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "outbox_messages" })
@Index({ properties: ["publishedAt", "nextAttemptAt"] })
export class OutboxMessageOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "varchar", length: 100 })
  aggregateId!: string;

  @Property({ type: "varchar", length: 100 })
  eventType!: string;

  @Property({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @Property({ type: "timestamptz" })
  occurredAt: Date = new Date();

  @Property({ type: "int", default: 0 })
  attempts: number = 0;

  @Property({ type: "timestamptz", nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: "timestamptz", nullable: true })
  publishedAt?: Date;
}
