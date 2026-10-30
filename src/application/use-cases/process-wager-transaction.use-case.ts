import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import {
  IdempotencyConflictError,
  InvalidAmountError,
  InvalidReferenceError,
  InvalidTransactionKindError,
  WalletNotFoundError,
} from "../../domain/errors/domain.error";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference.event";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.event";
import { FailureCode } from "../../domain/models/failure-code.enum";
import { InboxMessage } from "../../domain/models/inbox-message.entity";
import { Money, MoneyProps } from "../../domain/models/money.vo";
import { OutboxMessage } from "../../domain/models/outbox-message.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/models/wager-transaction.entity";
import { LedgerDirection } from "../../domain/models/wallet-ledger-entry.entity";
import { Wallet } from "../../domain/models/wallet.aggregate";
import { MikroOrmInboxRepository } from "../../infrastructure/database/repositories/mikro-orm-inbox.repository";
import { MikroOrmOutboxRepository } from "../../infrastructure/database/repositories/mikro-orm-outbox.repository";
import { MikroOrmWagerTransactionRepository } from "../../infrastructure/database/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-orm-wallet-ledger.repository";
import { MikroOrmWalletRepository } from "../../infrastructure/database/repositories/mikro-orm-wallet.repository";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import { CanonicalJsonService } from "../services/canonical-json.service";

export interface ProcessWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind | string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inbox?: {
    consumerName: string;
    messageId: string;
  };
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

const ALLOWED_EXTERNAL_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionResult> {
    const startTime = performance.now();
    const correlationId = input.correlationId ?? uuidv7();

    if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
      throw new InvalidAmountError("Idempotency-Key is required.");
    }
    if (input.idempotencyKey.length > 255) {
      throw new InvalidAmountError("Idempotency-Key must not exceed 255 characters.");
    }

    const fieldMaxLengths: Array<[keyof ProcessWagerTransactionInput, number]> = [
      ["providerId", 100],
      ["externalTransactionId", 150],
      ["playerId", 100],
      ["walletId", 100],
      ["roundId", 100],
      ["gameId", 100],
    ];
    for (const [field, maxLen] of fieldMaxLengths) {
      const val = input[field];
      if (!val || typeof val !== "string" || val.trim() === "") {
        throw new InvalidAmountError(`Field '${field}' must be a non-empty string.`);
      }
      if (val.length > maxLen) {
        throw new InvalidAmountError(`Field '${field}' must not exceed ${maxLen} characters.`);
      }
    }

    if (
      input.referenceExternalTransactionId !== undefined &&
      input.referenceExternalTransactionId.length > 150
    ) {
      throw new InvalidAmountError("Field 'referenceExternalTransactionId' must not exceed 150 characters.");
    }

    if (!ALLOWED_EXTERNAL_KINDS.has(input.kind)) {
      throw new InvalidTransactionKindError(String(input.kind));
    }

    const kind = input.kind as WagerTransactionKind;
    if (
      (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) &&
      (!input.referenceExternalTransactionId || input.referenceExternalTransactionId.trim() === "")
    ) {
      throw new InvalidReferenceError(`Transaction kind ${kind} requires referenceExternalTransactionId.`);
    }

    const money = Money.from(input.money);
    if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
      throw new InvalidAmountError(`Transaction amount for ${kind} must be strictly positive.`);
    }

    const canonicalPayload = CanonicalJsonService.extractBusinessPayload({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });
    const payloadHash = CanonicalJsonService.hash(canonicalPayload);

    try {
      const result = await this.em.transactional(async (txEm) => {
        const walletRepo = new MikroOrmWalletRepository(txEm);
        const wagerTxRepo = new MikroOrmWagerTransactionRepository(txEm);
        const ledgerRepo = new MikroOrmWalletLedgerRepository(txEm);
        const inboxRepo = new MikroOrmInboxRepository(txEm);
        const outboxRepo = new MikroOrmOutboxRepository(txEm);

        // 1. If coming from SQS, check persistent Inbox deduplication
        if (input.inbox) {
          const existingInbox = await inboxRepo.find(
            input.inbox.consumerName,
            input.inbox.messageId,
          );
          if (existingInbox) {
            if (existingInbox.payloadHash !== payloadHash) {
              throw new IdempotencyConflictError(
                `Inbox message '${input.inbox.messageId}' was previously processed with a different payload.`,
              );
            }
            if (existingInbox.isProcessed()) {
              const existingTx =
                (await wagerTxRepo.findByIdempotencyKey(input.idempotencyKey)) ??
                (await wagerTxRepo.findByProviderAndExternalId(
                  input.providerId,
                  input.externalTransactionId,
                ));
              if (existingTx) {
                if (!existingTx.matchesPayload(payloadHash)) {
                  throw new IdempotencyConflictError();
                }
                this.metrics.incrementDuplicatesDetected();
                this.logger.info("INBOX_DUPLICATE_DETECTED", "Duplicate SQS message skipped via Inbox", {
                  correlationId,
                  messageId: input.inbox.messageId,
                  providerId: input.providerId,
                  walletId: input.walletId,
                });
                return this.buildReplayResult(existingTx, walletRepo);
              }
            }
          }
        }

        // 2. Fast-path idempotency check before wallet lock (also catches cross-wallet key reuse)
        const existingPreLock = await wagerTxRepo.findByIdempotencyKey(input.idempotencyKey);
        if (existingPreLock) {
          if (!existingPreLock.matchesPayload(payloadHash)) {
            throw new IdempotencyConflictError();
          }
          if (input.inbox) {
            const inboxMsg = InboxMessage.receive({
              consumerName: input.inbox.consumerName,
              messageId: input.inbox.messageId,
              payloadHash,
            });
            inboxMsg.markProcessed();
            await inboxRepo.save(inboxMsg);
          }
          this.metrics.incrementDuplicatesDetected();
          this.logger.info("IDEMPOTENT_REPLAY", "Returning idempotent replay (pre-lock)", {
            correlationId,
            transactionId: existingPreLock.id,
            walletId: existingPreLock.walletId,
            providerId: existingPreLock.providerId,
            status: existingPreLock.status,
          });
          return this.buildReplayResult(existingPreLock, walletRepo);
        }

        // 3. Acquire per-wallet pessimistic write lock (SELECT ... FOR UPDATE)
        if (!UUID_REGEX.test(input.walletId)) {
          throw new WalletNotFoundError(input.walletId);
        }

        const wallet = await walletRepo.findForUpdate(input.walletId);
        if (!wallet) {
          throw new WalletNotFoundError(input.walletId);
        }

        // 4. Post-lock idempotency check (catches concurrent requests serialized by the wallet lock)
        const existingPostLock = await wagerTxRepo.findByIdempotencyKey(input.idempotencyKey);
        if (existingPostLock) {
          if (!existingPostLock.matchesPayload(payloadHash)) {
            throw new IdempotencyConflictError();
          }
          if (input.inbox) {
            const inboxMsg = InboxMessage.receive({
              consumerName: input.inbox.consumerName,
              messageId: input.inbox.messageId,
              payloadHash,
            });
            inboxMsg.markProcessed();
            await inboxRepo.save(inboxMsg);
          }
          this.metrics.incrementDuplicatesDetected();
          this.logger.info("IDEMPOTENT_REPLAY", "Returning idempotent replay (post-lock)", {
            correlationId,
            transactionId: existingPostLock.id,
            walletId: existingPostLock.walletId,
            providerId: existingPostLock.providerId,
            status: existingPostLock.status,
          });
          return this.buildReplayResult(existingPostLock, walletRepo, wallet);
        }

        const existingByProviderExt = await wagerTxRepo.findByProviderAndExternalId(
          input.providerId,
          input.externalTransactionId,
        );
        if (existingByProviderExt) {
          if (
            existingByProviderExt.idempotencyKey !== input.idempotencyKey ||
            !existingByProviderExt.matchesPayload(payloadHash)
          ) {
            throw new IdempotencyConflictError(
              `External transaction '${input.providerId}:${input.externalTransactionId}' already exists with different parameters.`,
            );
          }
          if (input.inbox) {
            const inboxMsg = InboxMessage.receive({
              consumerName: input.inbox.consumerName,
              messageId: input.inbox.messageId,
              payloadHash,
            });
            inboxMsg.markProcessed();
            await inboxRepo.save(inboxMsg);
          }
          this.metrics.incrementDuplicatesDetected();
          return this.buildReplayResult(existingByProviderExt, walletRepo, wallet);
        }

        // 5. Record Inbox message inside the same atomic SQL transaction
        if (input.inbox) {
          const inboxMsg = InboxMessage.receive({
            consumerName: input.inbox.consumerName,
            messageId: input.inbox.messageId,
            payloadHash,
          });
          inboxMsg.markProcessed();
          await inboxRepo.save(inboxMsg);
        }

        // 6. Create transaction in PENDING state and evaluate business rules
        const tx = WagerTransaction.create({
          id: uuidv7(),
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind,
          money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
        });

        const evaluation = await this.evaluateAndPersistTransaction(
          tx,
          wallet,
          { walletRepo, wagerTxRepo, ledgerRepo, outboxRepo },
          correlationId,
          input.inbox?.messageId,
        );

        this.metrics.incrementTransactionStatus(evaluation.status);
        return evaluation;
      });

      this.metrics.recordProcessingLatency(performance.now() - startTime);
      return result;
    } catch (error: unknown) {
      this.metrics.recordProcessingLatency(performance.now() - startTime);

      // Handle concurrent unique constraint race on idempotency_key or (provider_id, external_transaction_id)
      if (this.isUniqueConstraintViolation(error)) {
        this.metrics.incrementLockConflicts();
        return this.resolveConcurrentIdempotencyRace(input, payloadHash);
      }

      throw error;
    }
  }

  /**
   * Re-evaluates a single PENDING_REFERENCE transaction when called by the scheduled worker.
   */
  public async reprocessPendingTransaction(
    transactionId: string,
    correlationId: string = uuidv7(),
  ): Promise<ProcessWagerTransactionResult | null> {
    return this.em.transactional(async (txEm) => {
      const walletRepo = new MikroOrmWalletRepository(txEm);
      const wagerTxRepo = new MikroOrmWagerTransactionRepository(txEm);
      const ledgerRepo = new MikroOrmWalletLedgerRepository(txEm);
      const outboxRepo = new MikroOrmOutboxRepository(txEm);

      const tx = await wagerTxRepo.findById(transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) {
        return null;
      }

      const wallet = await walletRepo.findForUpdate(tx.walletId);
      if (!wallet) {
        tx.reject(FailureCode.WALLET_NOT_FOUND);
        await wagerTxRepo.save(tx);
        return null;
      }

      // Reload and lock tx after locking wallet, verifying that status is still
      // PENDING_REFERENCE and next_retry_at is due according to the database clock.
      const dueClaim = await wagerTxRepo.findDuePendingReferenceByIdForUpdate(transactionId);
      if (!dueClaim) {
        return null;
      }

      const result = await this.evaluateAndPersistTransaction(
        dueClaim.transaction,
        wallet,
        { walletRepo, wagerTxRepo, ledgerRepo, outboxRepo },
        correlationId,
        undefined,
        true,
        dueClaim.dbNow,
      );

      if (result.status !== WagerTransactionStatus.PendingReference) {
        this.metrics.incrementTransactionStatus(result.status);
      } else {
        this.metrics.incrementRetries();
      }

      return result;
    });
  }

  private async evaluateAndPersistTransaction(
    tx: WagerTransaction,
    wallet: Wallet,
    repos: {
      walletRepo: MikroOrmWalletRepository;
      wagerTxRepo: MikroOrmWagerTransactionRepository;
      ledgerRepo: MikroOrmWalletLedgerRepository;
      outboxRepo: MikroOrmOutboxRepository;
    },
    correlationId: string,
    messageId?: string,
    isRetryWorker = false,
    nowOverride?: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const now = nowOverride ?? new Date();

    // Validate player ownership
    if (wallet.playerId !== tx.playerId) {
      return this.rejectAndEnqueue(
        tx,
        wallet,
        FailureCode.PLAYER_MISMATCH,
        repos,
        correlationId,
        messageId,
      );
    }

    // Validate wallet currency
    if (wallet.currency !== tx.money.currency) {
      return this.rejectAndEnqueue(
        tx,
        wallet,
        FailureCode.CURRENCY_MISMATCH,
        repos,
        correlationId,
        messageId,
      );
    }

    // Resolve reference transaction if required or provided
    let refTx: WagerTransaction | undefined;
    if (tx.requiresReference() || tx.referenceExternalTransactionId) {
      const foundRef = await repos.wagerTxRepo.findByProviderAndExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId!,
      );

      if (
        !foundRef ||
        foundRef.status === WagerTransactionStatus.Pending ||
        foundRef.status === WagerTransactionStatus.PendingReference
      ) {
        if (isRetryWorker) {
          tx.scheduleReferenceRetry(now);
          if (tx.hasExhaustedReferenceRetries()) {
            return this.rejectAndEnqueue(
              tx,
              wallet,
              FailureCode.REFERENCE_NOT_FOUND,
              repos,
              correlationId,
              messageId,
            );
          }
          await repos.wagerTxRepo.save(tx);
          this.logger.warn("PENDING_REFERENCE_RETRY_SCHEDULED", "Reference still missing; scheduled next retry", {
            correlationId,
            transactionId: tx.id,
            walletId: wallet.id,
            providerId: tx.providerId,
            retryAttempts: tx.retryAttempts,
          });
          return {
            transactionId: tx.id,
            status: tx.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }

        tx.markPendingReference(now, wallet.balance);
        await repos.wagerTxRepo.save(tx);

        const pendingEvent = WagerTransactionPendingReference.from(tx, {
          eventId: uuidv7(),
          correlationId,
          causationId: messageId,
        });
        await repos.outboxRepo.save(OutboxMessage.enqueue(pendingEvent));

        this.logger.warn("TRANSACTION_PENDING_REFERENCE", "Referenced transaction not yet found", {
          correlationId,
          messageId,
          transactionId: tx.id,
          walletId: wallet.id,
          providerId: tx.providerId,
          kind: tx.kind,
          status: tx.status,
        });

        return {
          transactionId: tx.id,
          status: tx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
      }

      // Reference exists in terminal state -> validate reference integrity
      if (
        foundRef.status !== WagerTransactionStatus.Processed ||
        foundRef.providerId !== tx.providerId ||
        foundRef.playerId !== tx.playerId ||
        foundRef.walletId !== tx.walletId ||
        foundRef.money.currency !== tx.money.currency ||
        foundRef.roundId !== tx.roundId
      ) {
        return this.rejectAndEnqueue(
          tx,
          wallet,
          FailureCode.INVALID_REFERENCE,
          repos,
          correlationId,
          messageId,
        );
      }

      // Validate allowed reference kinds
      if (tx.kind === WagerTransactionKind.Refund && foundRef.kind !== WagerTransactionKind.Bet) {
        return this.rejectAndEnqueue(
          tx,
          wallet,
          FailureCode.INVALID_REFERENCE,
          repos,
          correlationId,
          messageId,
        );
      }

      if (
        tx.kind === WagerTransactionKind.Rollback &&
        foundRef.kind !== WagerTransactionKind.Bet &&
        foundRef.kind !== WagerTransactionKind.Win &&
        foundRef.kind !== WagerTransactionKind.Refund
      ) {
        return this.rejectAndEnqueue(
          tx,
          wallet,
          FailureCode.INVALID_REFERENCE,
          repos,
          correlationId,
          messageId,
        );
      }

      if (
        (tx.kind === WagerTransactionKind.Win || tx.kind === WagerTransactionKind.Loss) &&
        foundRef.kind !== WagerTransactionKind.Bet
      ) {
        return this.rejectAndEnqueue(
          tx,
          wallet,
          FailureCode.INVALID_REFERENCE,
          repos,
          correlationId,
          messageId,
        );
      }

      // Additional checks for reversals (REFUND / ROLLBACK)
      if (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback) {
        if (!tx.money.equals(foundRef.money)) {
          return this.rejectAndEnqueue(
            tx,
            wallet,
            FailureCode.REVERSAL_AMOUNT_MISMATCH,
            repos,
            correlationId,
            messageId,
          );
        }

        const existingReversal = await repos.wagerTxRepo.findProcessedReversalByReferenceId(
          foundRef.id,
        );
        if (existingReversal && existingReversal.id !== tx.id) {
          return this.rejectAndEnqueue(
            tx,
            wallet,
            FailureCode.ALREADY_REVERSED,
            repos,
            correlationId,
            messageId,
          );
        }
      }

      refTx = foundRef;
    }

    // Handle non-balance-affecting operation (LOSS)
    if (!tx.affectsBalance()) {
      tx.markProcessed(refTx?.id, now, wallet.balance);
      await repos.wagerTxRepo.save(tx);

      const processedEvent = WagerTransactionProcessed.from(tx, {
        eventId: uuidv7(),
        correlationId,
        causationId: messageId,
      });
      await repos.outboxRepo.save(OutboxMessage.enqueue(processedEvent));

      this.logger.info("TRANSACTION_PROCESSED", "LOSS transaction recorded without balance change", {
        correlationId,
        messageId,
        transactionId: tx.id,
        walletId: wallet.id,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
      });

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    // Balance-affecting operations (BET, WIN, REFUND, ROLLBACK)
    const direction = tx.ledgerDirectionFor(refTx);

    if (direction === LedgerDirection.Debit) {
      if (wallet.balance.isLessThan(tx.money)) {
        const failureCode =
          tx.kind === WagerTransactionKind.Rollback
            ? FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE
            : FailureCode.INSUFFICIENT_FUNDS;

        return this.rejectAndEnqueue(
          tx,
          wallet,
          failureCode,
          repos,
          correlationId,
          messageId,
        );
      }

      const { newBalance, entry } = wallet.debit(tx.money, tx.id, uuidv7(), now);
      tx.markProcessed(refTx?.id, now, newBalance);

      await repos.walletRepo.save(wallet);
      await repos.wagerTxRepo.save(tx);
      await repos.ledgerRepo.save(entry);

      const processedEvent = WagerTransactionProcessed.from(tx, {
        eventId: uuidv7(),
        correlationId,
        causationId: messageId,
      });
      const balanceEvent = WalletBalanceChanged.from(wallet, entry, {
        eventId: uuidv7(),
        correlationId,
        causationId: tx.id,
      });

      await repos.outboxRepo.save(OutboxMessage.enqueue(processedEvent));
      await repos.outboxRepo.save(OutboxMessage.enqueue(balanceEvent));

      this.logger.info("TRANSACTION_PROCESSED", "Debit transaction processed successfully", {
        correlationId,
        messageId,
        transactionId: tx.id,
        walletId: wallet.id,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
      });

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: newBalance.toJSON(),
        idempotentReplay: false,
      };
    } else {
      const { newBalance, entry } = wallet.credit(tx.money, tx.id, uuidv7(), now);
      tx.markProcessed(refTx?.id, now, newBalance);

      await repos.walletRepo.save(wallet);
      await repos.wagerTxRepo.save(tx);
      await repos.ledgerRepo.save(entry);

      const processedEvent = WagerTransactionProcessed.from(tx, {
        eventId: uuidv7(),
        correlationId,
        causationId: messageId,
      });
      const balanceEvent = WalletBalanceChanged.from(wallet, entry, {
        eventId: uuidv7(),
        correlationId,
        causationId: tx.id,
      });

      await repos.outboxRepo.save(OutboxMessage.enqueue(processedEvent));
      await repos.outboxRepo.save(OutboxMessage.enqueue(balanceEvent));

      this.logger.info("TRANSACTION_PROCESSED", "Credit transaction processed successfully", {
        correlationId,
        messageId,
        transactionId: tx.id,
        walletId: wallet.id,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
      });

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: newBalance.toJSON(),
        idempotentReplay: false,
      };
    }
  }

  private async rejectAndEnqueue(
    tx: WagerTransaction,
    wallet: Wallet,
    failureCode: FailureCode,
    repos: {
      wagerTxRepo: MikroOrmWagerTransactionRepository;
      outboxRepo: MikroOrmOutboxRepository;
    },
    correlationId: string,
    messageId?: string,
  ): Promise<ProcessWagerTransactionResult> {
    tx.reject(failureCode, wallet.balance);
    await repos.wagerTxRepo.save(tx);

    const rejectedEvent = WagerTransactionRejected.from(tx, {
      eventId: uuidv7(),
      correlationId,
      causationId: messageId,
    });
    await repos.outboxRepo.save(OutboxMessage.enqueue(rejectedEvent));

    this.logger.warn("TRANSACTION_REJECTED", `Transaction rejected: ${failureCode}`, {
      correlationId,
      messageId,
      transactionId: tx.id,
      walletId: wallet.id,
      providerId: tx.providerId,
      kind: tx.kind,
      status: tx.status,
      failureCode,
    });

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      failureCode,
    };
  }

  private async buildReplayResult(
    tx: WagerTransaction,
    walletRepo: MikroOrmWalletRepository,
    loadedWallet?: Wallet,
  ): Promise<ProcessWagerTransactionResult> {
    let observedBalance = tx.observedBalance;
    if (!observedBalance) {
      const wallet = loadedWallet ?? (await walletRepo.findById(tx.walletId));
      observedBalance = wallet ? wallet.balance : Money.zero(tx.money.currency);
    }

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: observedBalance.toJSON(),
      idempotentReplay: true,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    };
  }

  private async resolveConcurrentIdempotencyRace(
    input: ProcessWagerTransactionInput,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const forkEm = this.em.fork();
    const wagerTxRepo = new MikroOrmWagerTransactionRepository(forkEm);
    const walletRepo = new MikroOrmWalletRepository(forkEm);

    const existing =
      (await wagerTxRepo.findByIdempotencyKey(input.idempotencyKey)) ??
      (await wagerTxRepo.findByProviderAndExternalId(
        input.providerId,
        input.externalTransactionId,
      ));

    if (!existing) {
      throw new IdempotencyConflictError();
    }

    if (
      existing.idempotencyKey !== input.idempotencyKey ||
      !existing.matchesPayload(payloadHash)
    ) {
      throw new IdempotencyConflictError();
    }

    this.metrics.incrementDuplicatesDetected();
    return this.buildReplayResult(existing, walletRepo);
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const err = error as Record<string, unknown>;
    const msg = String(err.message ?? "");
    return (
      err.code === "23505" ||
      msg.includes("uq_wager_tx_idempotency_key") ||
      msg.includes("uq_wager_tx_provider_external") ||
      msg.includes("uq_wager_tx_single_processed_reversal")
    );
  }
}
