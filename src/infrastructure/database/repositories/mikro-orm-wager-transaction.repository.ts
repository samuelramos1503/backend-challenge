import Decimal from "decimal.js";
import { EntityManager } from "@mikro-orm/postgresql";
import { IWagerTransactionRepository } from "../../../domain/repositories/wager-transaction.repository.interface";
import { FailureCode } from "../../../domain/models/failure-code.enum";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/models/wager-transaction.entity";
import { WagerTransactionOrmEntity } from "../entities/wager-transaction.orm-entity";

export class MikroOrmWagerTransactionRepository implements IWagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionOrmEntity, { id }, { refresh: true });
    return entity ? this.toDomain(entity) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionOrmEntity,
      { idempotencyKey: key },
      { refresh: true }
    );
    return entity ? this.toDomain(entity) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionOrmEntity,
      {
        providerId,
        externalTransactionId,
      },
      { refresh: true }
    );
    return entity ? this.toDomain(entity) : null;
  }

  async findProcessedReversalByReferenceId(
    referenceTransactionId: string
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(
      WagerTransactionOrmEntity,
      {
        referenceTransactionId,
        status: WagerTransactionStatus.Processed,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      },
      { refresh: true }
    );
    return entity ? this.toDomain(entity) : null;
  }

  async findPendingReferences(limit = 50): Promise<WagerTransaction[]> {
    const entities = await this.em.find(
      WagerTransactionOrmEntity,
      { status: WagerTransactionStatus.PendingReference },
      { limit, orderBy: { createdAt: "ASC" }, refresh: true }
    );
    return entities.map((e) => this.toDomain(e));
  }

  async findDuePendingReferences(limit = 50): Promise<WagerTransaction[]> {
    const conn = this.em.getConnection();
    const rows = await conn.execute<
      {
        id: string;
        provider_id: string;
        external_transaction_id: string;
        idempotency_key: string;
        payload_hash: string;
        wallet_id: string;
        player_id: string;
        round_id: string;
        game_id: string;
        kind: WagerTransactionKind;
        amount: string;
        currency: string;
        status: WagerTransactionStatus;
        reference_external_transaction_id?: string;
        reference_transaction_id?: string;
        failure_code?: FailureCode;
        observed_balance?: string;
        observed_balance_currency?: string;
        retry_attempts: number;
        next_retry_at?: string;
        processed_at?: string;
        created_at: string;
      }[]
    >(
      `SELECT id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
              reference_external_transaction_id, reference_transaction_id, failure_code,
              observed_balance, observed_balance_currency, retry_attempts, next_retry_at, processed_at, created_at
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY created_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [limit],
      "all",
      this.em.getTransactionContext(),
    );

    return rows.map((r) => this.rehydrateRow(r));
  }

  async findDuePendingReferenceByIdForUpdate(
    id: string,
  ): Promise<{ transaction: WagerTransaction; dbNow: Date } | null> {
    const conn = this.em.getConnection();
    const rows = await conn.execute<
      {
        id: string;
        provider_id: string;
        external_transaction_id: string;
        idempotency_key: string;
        payload_hash: string;
        wallet_id: string;
        player_id: string;
        round_id: string;
        game_id: string;
        kind: WagerTransactionKind;
        amount: string;
        currency: string;
        status: WagerTransactionStatus;
        reference_external_transaction_id?: string;
        reference_transaction_id?: string;
        failure_code?: FailureCode;
        observed_balance?: string;
        observed_balance_currency?: string;
        retry_attempts: number;
        next_retry_at?: string;
        processed_at?: string;
        created_at: string;
        db_now: string;
      }[]
    >(
      `SELECT id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
              reference_external_transaction_id, reference_transaction_id, failure_code,
              observed_balance, observed_balance_currency, retry_attempts, next_retry_at, processed_at, created_at,
              NOW() AS db_now
       FROM wager_transactions
       WHERE id = ?
         AND status = 'PENDING_REFERENCE'
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       FOR UPDATE`,
      [id],
      "all",
      this.em.getTransactionContext(),
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      transaction: this.rehydrateRow(row),
      dbNow: new Date(row.db_now),
    };
  }

  private rehydrateRow(r: {
    id: string;
    provider_id: string;
    external_transaction_id: string;
    idempotency_key: string;
    payload_hash: string;
    wallet_id: string;
    player_id: string;
    round_id: string;
    game_id: string;
    kind: WagerTransactionKind;
    amount: string;
    currency: string;
    status: WagerTransactionStatus;
    reference_external_transaction_id?: string;
    reference_transaction_id?: string;
    failure_code?: FailureCode;
    observed_balance?: string;
    observed_balance_currency?: string;
    retry_attempts: number;
    next_retry_at?: string;
    processed_at?: string;
    created_at: string;
  }): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.provider_id,
      externalTransactionId: r.external_transaction_id,
      idempotencyKey: r.idempotency_key,
      payloadHash: r.payload_hash,
      walletId: r.wallet_id,
      playerId: r.player_id,
      roundId: r.round_id,
      gameId: r.game_id,
      kind: r.kind,
      money: {
        amount: new Decimal(r.amount).toFixed(2),
        currency: r.currency,
      },
      status: r.status,
      referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
      referenceTransactionId: r.reference_transaction_id ?? undefined,
      failureCode: r.failure_code ?? undefined,
      observedBalance:
        r.observed_balance !== null && r.observed_balance !== undefined
          ? {
              amount: new Decimal(r.observed_balance).toFixed(2),
              currency: r.observed_balance_currency ?? r.currency,
            }
          : undefined,
      retryAttempts: Number(r.retry_attempts ?? 0),
      nextRetryAt: r.next_retry_at ? new Date(r.next_retry_at) : undefined,
      processedAt: r.processed_at ? new Date(r.processed_at) : undefined,
      createdAt: new Date(r.created_at),
    });
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
    entity.observedBalance = transaction.observedBalance?.amount;
    entity.observedBalanceCurrency = transaction.observedBalance?.currency;
    entity.retryAttempts = transaction.retryAttempts;
    entity.nextRetryAt = transaction.nextRetryAt;
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
      observedBalance: entity.observedBalance
        ? {
            amount: entity.observedBalance,
            currency: entity.observedBalanceCurrency ?? entity.currency,
          }
        : undefined,
      retryAttempts: entity.retryAttempts,
      nextRetryAt: entity.nextRetryAt,
      processedAt: entity.processedAt,
      createdAt: entity.createdAt,
    });
  }
}
