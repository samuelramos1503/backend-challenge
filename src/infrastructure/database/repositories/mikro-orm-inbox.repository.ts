import { EntityManager } from "@mikro-orm/postgresql";
import { IInboxRepository } from "../../../domain/repositories/inbox.repository.interface";
import { InboxMessage } from "../../../domain/models/inbox-message.entity";
import { InboxMessageOrmEntity } from "../entities/inbox-message.orm-entity";

export class MikroOrmInboxRepository implements IInboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const entity = await this.em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
    if (!entity) return null;

    return InboxMessage.rehydrate({
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt,
    });
  }

  async save(message: InboxMessage): Promise<void> {
    let entity = await this.em.findOne(InboxMessageOrmEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });

    if (!entity) {
      entity = new InboxMessageOrmEntity();
      entity.consumerName = message.consumerName;
      entity.messageId = message.messageId;
      entity.payloadHash = message.payloadHash;
      entity.receivedAt = message.receivedAt;
      this.em.persist(entity);
    }

    entity.processedAt = message.processedAt;
  }
}
