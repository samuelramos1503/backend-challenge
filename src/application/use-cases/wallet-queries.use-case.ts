import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { TransactionNotFoundError, WalletNotFoundError } from "../../domain/errors/domain.error";
import { MoneyProps } from "../../domain/models/money.vo";
import { MikroOrmWagerTransactionRepository } from "../../infrastructure/database/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-orm-wallet-ledger.repository";
import { MikroOrmWalletRepository } from "../../infrastructure/database/repositories/mikro-orm-wallet.repository";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface PaginatedLedgerView {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  balance?: MoneyProps;
  processedAt?: string;
  createdAt: string;
}

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  public async execute(walletId: string): Promise<WalletView> {
    if (!UUID_REGEX.test(walletId)) {
      throw new WalletNotFoundError(walletId);
    }

    const walletRepo = new MikroOrmWalletRepository(this.em.fork());
    const wallet = await walletRepo.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}

@Injectable()
export class GetLedgerEntriesUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  public async execute(
    walletId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<PaginatedLedgerView> {
    if (!UUID_REGEX.test(walletId)) {
      throw new WalletNotFoundError(walletId);
    }

    const forkEm = this.em.fork();
    const walletRepo = new MikroOrmWalletRepository(forkEm);
    const ledgerRepo = new MikroOrmWalletLedgerRepository(forkEm);

    const wallet = await walletRepo.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const page = await ledgerRepo.findByWalletId(walletId, { cursor, limit });

    return {
      walletId,
      entries: page.entries.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor ?? null,
      hasMore: page.hasMore,
    };
  }
}

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  public async executeById(transactionId: string): Promise<WagerTransactionView> {
    if (!UUID_REGEX.test(transactionId)) {
      throw new TransactionNotFoundError(transactionId);
    }

    const repo = new MikroOrmWagerTransactionRepository(this.em.fork());
    const tx = await repo.findById(transactionId);
    if (!tx) {
      throw new TransactionNotFoundError(transactionId);
    }

    return this.toView(tx);
  }

  public async executeByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const repo = new MikroOrmWagerTransactionRepository(this.em.fork());
    const tx = await repo.findByProviderAndExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }

    return this.toView(tx);
  }

  private toView(tx: import("../../domain/models/wager-transaction.entity").WagerTransaction): WagerTransactionView {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      ...(tx.referenceExternalTransactionId
        ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
        : {}),
      ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
      ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
      createdAt: tx.createdAt.toISOString(),
    };
  }
}
