import { EntityManager } from "@mikro-orm/postgresql";
import { IWagerTransactionRepository } from "../../../domain/repositories/wager-transaction.repository.interface";
import {
  WagerTransaction,
  WagerTransactionStatus,
} from "../../../domain/models/wager-transaction.entity";
import { WagerTransactionOrmEntity } from "../entities/wager-transaction.orm-entity";

export class MikroOrmWagerTransactionRepository implements IWagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionOrmEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionOrmEntity, { idempotencyKey: key });
    return entity ? this.toDomain(entity) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId,
    });
    return entity ? this.toDomain(entity) : null;
  }

  async findPendingReferences(limit = 50): Promise<WagerTransaction[]> {
    const entities = await this.em.find(
      WagerTransactionOrmEntity,
      { status: WagerTransactionStatus.PendingReference },
      { limit, orderBy: { createdAt: "ASC" } }
    );
    return entities.map((e) => this.toDomain(e));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    let entity = await this.em.findOne(WagerTransactionOrmEntity, { id: transaction.id });
    if (!entity) {
      entity = new WagerTransactionOrmEntity();
      entity.id = transaction.id;
      entity.providerId = transaction.providerId;
      entity.externalTransactionId = transaction.externalTransactionId;
      entity.idempotencyKey = transaction.idempotencyKey;
      entity.payloadHash = transaction.payloadHash;
      entity.walletId = transaction.walletId;
      entity.playerId = transaction.playerId;
      entity.roundId = transaction.roundId;
      entity.gameId = transaction.gameId;
      entity.kind = transaction.kind;
      entity.amount = transaction.money.amount;
      entity.currency = transaction.money.currency;
      entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
      entity.createdAt = transaction.createdAt;
      this.em.persist(entity);
    }

    entity.status = transaction.status;
    entity.referenceTransactionId = transaction.referenceTransactionId;
    entity.failureCode = transaction.failureCode;
    entity.processedAt = transaction.processedAt;
  }

  private toDomain(entity: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind,
      money: {
        amount: entity.amount,
        currency: entity.currency,
      },
      status: entity.status,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      failureCode: entity.failureCode,
      processedAt: entity.processedAt,
      createdAt: entity.createdAt,
    });
  }
}
