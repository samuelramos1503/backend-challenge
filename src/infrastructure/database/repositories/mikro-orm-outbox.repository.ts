import { EntityManager } from "@mikro-orm/postgresql";
import { IOutboxRepository } from "../../../domain/repositories/outbox.repository.interface";
import { OutboxMessage } from "../../../domain/models/outbox-message.entity";
import { OutboxMessageOrmEntity } from "../entities/outbox-message.orm-entity";

export class MikroOrmOutboxRepository implements IOutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async save(message: OutboxMessage): Promise<void> {
    const entity = new OutboxMessageOrmEntity();
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.payload = message.payload as Record<string, unknown>;
    entity.occurredAt = message.occurredAt;
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt;
    entity.publishedAt = message.publishedAt;

    this.em.persist(entity);
  }

  async findDueMessages(limit = 20): Promise<OutboxMessage[]> {
    // Uses native SQL with FOR UPDATE SKIP LOCKED to guarantee safe concurrent worker pickup
    const conn = this.em.getConnection();
    const rows = await conn.execute<
      {
        id: string;
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        occurred_at: string;
        attempts: number;
        next_attempt_at?: string;
        published_at?: string;
      }[]
    >(
      `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
       FROM outbox_messages
       WHERE published_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
       ORDER BY occurred_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [limit],
      "all",
      this.em.getTransactionContext(),
    );

    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregate_id,
        eventType: r.event_type,
        payload: r.payload,
        occurredAt: new Date(r.occurred_at),
        attempts: Number(r.attempts),
        nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
        publishedAt: r.published_at ? new Date(r.published_at) : undefined,
      })
    );
  }

  async markPublished(id: string, at: Date = new Date()): Promise<void> {
    const conn = this.em.getConnection();
    await conn.execute(
      `UPDATE outbox_messages SET published_at = ? WHERE id = ?`,
      [at, id],
      "run",
      this.em.getTransactionContext(),
    );
  }

  async scheduleRetry(id: string, now: Date = new Date()): Promise<void> {
    const conn = this.em.getConnection();
    await conn.execute(
      `UPDATE outbox_messages
       SET attempts = attempts + 1,
           next_attempt_at = ?::timestamptz + (LEAST(60, POWER(2, attempts)) || ' seconds')::INTERVAL
       WHERE id = ?`,
      [now.toISOString(), id],
      "run",
      this.em.getTransactionContext(),
    );
  }
}
