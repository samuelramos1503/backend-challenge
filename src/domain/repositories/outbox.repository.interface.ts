import { OutboxMessage } from "../models/outbox-message.entity";

export interface IOutboxRepository {
  save(message: OutboxMessage): Promise<void>;
  findDueMessages(limit: number): Promise<OutboxMessage[]>;
  markPublished(id: string, at?: Date): Promise<void>;
  scheduleRetry(id: string, now?: Date): Promise<void>;
}
