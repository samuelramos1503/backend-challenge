import Decimal from "decimal.js";
import { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../../domain/models/money.vo";
import {
  IWalletLedgerRepository,
  LedgerCursorPaginationOptions,
  LedgerCursorPaginationResult,
  LedgerReconciliationSummary,
} from "../../../domain/repositories/wallet-ledger.repository.interface";
import { WalletLedgerEntry } from "../../../domain/models/wallet-ledger-entry.entity";
import { WalletLedgerEntryOrmEntity } from "../entities/wallet-ledger-entry.orm-entity";

export class MikroOrmWalletLedgerRepository implements IWalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    const entity = new WalletLedgerEntryOrmEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.amount;
    entity.currency = entry.money.currency;
    entity.balanceBefore = entry.balanceBefore.amount;
    entity.balanceAfter = entry.balanceAfter.amount;
    entity.createdAt = entry.createdAt;

    this.em.persist(entity);
  }

  async findByWalletId(
    walletId: string,
    options: LedgerCursorPaginationOptions
  ): Promise<LedgerCursorPaginationResult> {
    const limit = Math.min(Math.max(options.limit || 50, 1), 100);
    const qb = this.em.createQueryBuilder(WalletLedgerEntryOrmEntity, "l");
    qb.where({ walletId });

    if (options.cursor) {
      const decoded = this.decodeCursor(options.cursor);
      if (decoded) {
        qb.andWhere(
          "(l.created_at < ? OR (l.created_at = ? AND l.id < ?))",
          [decoded.createdAt, decoded.createdAt, decoded.id]
        );
      }
    }

    qb.orderBy({ createdAt: "DESC", id: "DESC" });
    qb.limit(limit + 1);

    const entities = await qb.getResultList();
    const hasMore = entities.length > limit;
    const pageEntities = hasMore ? entities.slice(0, limit) : entities;

    const entries = pageEntities.map((e) => this.toDomain(e));
    let nextCursor: string | undefined;

    if (hasMore && pageEntities.length > 0) {
      const last = pageEntities[pageEntities.length - 1];
      nextCursor = this.encodeCursor(last.createdAt, last.id);
    }

    return {
      entries,
      nextCursor,
      hasMore,
    };
  }

  async reconcileWallet(walletId: string, currency: string): Promise<LedgerReconciliationSummary> {
    const conn = this.em.getConnection();
    const res = await conn.execute<{
      total_credit: string;
      total_debit: string;
      total_count: string;
    }[]>(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS total_credit,
         COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS total_debit,
         COUNT(*) AS total_count
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId]
    );

    const row = res[0] || { total_credit: "0.00", total_debit: "0.00", total_count: "0" };
    const totalCredit = Money.from({
      amount: new Decimal(row.total_credit || "0").toFixed(2),
      currency,
    });
    const totalDebit = Money.from({
      amount: new Decimal(row.total_debit || "0").toFixed(2),
      currency,
    });
    const calculatedBalance = totalCredit.subtract(totalDebit);

    return {
      walletId,
      totalCredit,
      totalDebit,
      calculatedBalance,
      totalEntries: parseInt(row.total_count || "0", 10),
    };
  }

  private encodeCursor(createdAt: Date, id: string): string {
    const payload = JSON.stringify({ createdAt: createdAt.toISOString(), id });
    return Buffer.from(payload, "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
    try {
      const json = Buffer.from(cursor, "base64url").toString("utf8");
      const parsed = JSON.parse(json);
      if (parsed.createdAt && parsed.id) {
        return { createdAt: new Date(parsed.createdAt), id: parsed.id };
      }
    } catch {
      return null;
    }
    return null;
  }

  private toDomain(entity: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction,
      money: {
        amount: entity.amount,
        currency: entity.currency,
      },
      balanceBefore: {
        amount: entity.balanceBefore,
        currency: entity.currency,
      },
      balanceAfter: {
        amount: entity.balanceAfter,
        currency: entity.currency,
      },
      createdAt: entity.createdAt,
    });
  }
}
