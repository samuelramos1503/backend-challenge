import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { DuplicateWalletError, InvalidAmountError } from "../../domain/errors/domain.error";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.event";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.event";
import { Money, MoneyProps } from "../../domain/models/money.vo";
import { OutboxMessage } from "../../domain/models/outbox-message.entity";
import { WagerTransaction, WagerTransactionKind } from "../../domain/models/wager-transaction.entity";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/models/wallet-ledger-entry.entity";
import { Wallet } from "../../domain/models/wallet.aggregate";
import { MikroOrmOutboxRepository } from "../../infrastructure/database/repositories/mikro-orm-outbox.repository";
import { MikroOrmWagerTransactionRepository } from "../../infrastructure/database/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-orm-wallet-ledger.repository";
import { MikroOrmWalletRepository } from "../../infrastructure/database/repositories/mikro-orm-wallet.repository";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import { CanonicalJsonService } from "../services/canonical-json.service";

export interface CreateWalletInput {
  playerId: string;
  initialBalance?: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService,
  ) {}

  public async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    if (!input?.playerId || typeof input.playerId !== "string" || input.playerId.trim() === "") {
      throw new InvalidAmountError("playerId must be a non-empty string.");
    }

    const initialMoney = input.initialBalance
      ? Money.from(input.initialBalance)
      : Money.zero("BRL");

    const correlationId = input.correlationId ?? uuidv7();
    const now = new Date();

    try {
      return await this.em.transactional(async (txEm) => {
        const walletRepo = new MikroOrmWalletRepository(txEm);
        const wagerTxRepo = new MikroOrmWagerTransactionRepository(txEm);
        const ledgerRepo = new MikroOrmWalletLedgerRepository(txEm);
        const outboxRepo = new MikroOrmOutboxRepository(txEm);

        const existing = await walletRepo.findByPlayerAndCurrency(
          input.playerId,
          initialMoney.currency,
        );
        if (existing) {
          throw new DuplicateWalletError(input.playerId, initialMoney.currency);
        }

        const walletId = uuidv7();
        const { wallet } = Wallet.open({
          id: walletId,
          playerId: input.playerId,
          initialBalance: initialMoney,
          createdAt: now,
        });

        await walletRepo.save(wallet);

        if (initialMoney.isPositive()) {
          const openingTxId = uuidv7();
          const openingIdempotencyKey = `internal:opening:${walletId}`;
          const payloadHash = CanonicalJsonService.hash({
            kind: WagerTransactionKind.Opening,
            walletId,
            playerId: input.playerId,
            money: initialMoney.toJSON(),
          });

          const openingTx = WagerTransaction.create({
            id: openingTxId,
            providerId: "internal-system",
            externalTransactionId: `opening-${walletId}`,
            idempotencyKey: openingIdempotencyKey,
            payloadHash,
            walletId,
            playerId: input.playerId,
            roundId: `opening-round-${walletId}`,
            gameId: "wallet-opening",
            kind: WagerTransactionKind.Opening,
            money: initialMoney,
            createdAt: now,
          });

          openingTx.markProcessed(undefined, now, initialMoney);

          const openingLedgerEntry = WalletLedgerEntry.create({
            id: uuidv7(),
            walletId,
            transactionId: openingTxId,
            direction: LedgerDirection.Credit,
            money: initialMoney,
            balanceBefore: Money.zero(initialMoney.currency),
            balanceAfter: initialMoney,
            createdAt: now,
          });

          await wagerTxRepo.save(openingTx);
          await ledgerRepo.save(openingLedgerEntry);

          const processedEvent = WagerTransactionProcessed.from(openingTx, {
            eventId: uuidv7(),
            correlationId,
          });
          const balanceChangedEvent = WalletBalanceChanged.from(wallet, openingLedgerEntry, {
            eventId: uuidv7(),
            correlationId,
            causationId: openingTx.id,
          });

          await outboxRepo.save(OutboxMessage.enqueue(processedEvent));
          await outboxRepo.save(OutboxMessage.enqueue(balanceChangedEvent));
        }

        this.logger.info("WALLET_CREATED", "Wallet opened successfully", {
          correlationId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
        });

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error: unknown) {
      if (error instanceof DuplicateWalletError) {
        throw error;
      }
      if (this.isUniqueConstraintViolation(error)) {
        throw new DuplicateWalletError(input.playerId, initialMoney.currency);
      }
      throw error;
    }
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const err = error as Record<string, unknown>;
    return err.code === "23505" || String(err.message ?? "").includes("uq_wallets_player_currency");
  }
}
