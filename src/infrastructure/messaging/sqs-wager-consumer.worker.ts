import { Message } from "@aws-sdk/client-sqs";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import {
  DomainError,
  IdempotencyConflictError,
  InvalidAmountError,
  InvalidReferenceError,
  InvalidTransactionKindError,
  WalletNotFoundError,
} from "../../domain/errors/domain.error";
import { MetricsService } from "../observability/metrics.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { SqsService, WAGER_TRANSACTIONS_DLQ, WAGER_TRANSACTIONS_QUEUE } from "./sqs.service";

export interface SqsWagerMessageEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

export interface SqsConsumeOptions {
  /** Simulates a worker crash after DB commit and before SQS ACK (for crash-recovery tests). */
  simulateCrashBeforeAck?: boolean;
}

@Injectable()
export class SqsWagerConsumerWorker implements OnModuleInit, OnModuleDestroy {
  public static readonly CONSUMER_NAME = "sqs-wager-consumer";
  public static readonly MAX_RECEIVE_ATTEMPTS = 3;

  private timer?: ReturnType<typeof setInterval>;
  private isShuttingDown = false;
  private activePollPromise: Promise<number> | null = null;

  constructor(
    @Inject(SqsService) private readonly sqsService: SqsService,
    @Inject(ProcessWagerTransactionUseCase) private readonly processUseCase: ProcessWagerTransactionUseCase,
    @Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public onModuleInit(): void {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") {
      return;
    }
    const intervalMs = parseInt(process.env.SQS_POLL_INTERVAL_MS || "500", 10);
    this.timer = setInterval(() => {
      if (!this.isShuttingDown && !this.activePollPromise) {
        this.activePollPromise = this.pollOnce()
          .catch((err) => {
            this.logger.error("SQS_CONSUMER_POLL_ERROR", "Error polling SQS wager queue", {
              error: err instanceof Error ? err.message : String(err),
            });
            return 0;
          })
          .finally(() => {
            this.activePollPromise = null;
          });
      }
    }, intervalMs);
  }

  public async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.activePollPromise) {
      await this.activePollPromise;
    }
  }

  public async pollOnce(options: SqsConsumeOptions = {}): Promise<number> {
    const messages = await this.sqsService.receiveMessages(WAGER_TRANSACTIONS_QUEUE, 10, 0, 30);
    let processedCount = 0;

    for (const msg of messages) {
      if (this.isShuttingDown) {
        if (msg.ReceiptHandle) {
          await this.sqsService.changeMessageVisibility(WAGER_TRANSACTIONS_QUEUE, msg.ReceiptHandle, 0);
        }
        continue;
      }

      await this.handleMessage(msg, options);
      processedCount += 1;
    }

    return processedCount;
  }

  public async handleMessage(msg: Message, options: SqsConsumeOptions = {}): Promise<void> {
    const receiptHandle = msg.ReceiptHandle;
    const receiveCount = parseInt(msg.Attributes?.ApproximateReceiveCount || "1", 10);
    const correlationId = uuidv7();

    let envelope: SqsWagerMessageEnvelope;
    try {
      envelope = JSON.parse(msg.Body || "{}") as SqsWagerMessageEnvelope;
      if (!envelope || !envelope.messageId || !envelope.data) {
        throw new Error("Invalid SQS message envelope: missing messageId or data.");
      }
    } catch (parseError) {
      // Malformed JSON or envelope is permanent -> move to DLQ immediately
      await this.moveToDlq(msg, "MALFORMED_MESSAGE_ENVELOPE", parseError, correlationId);
      return;
    }

    const { data, messageId } = envelope;
    const idempotencyKey =
      data.idempotencyKey || `${data.providerId}:${data.externalTransactionId}`;

    try {
      await this.processUseCase.execute({
        idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId,
        inbox: {
          consumerName: SqsWagerConsumerWorker.CONSUMER_NAME,
          messageId,
        },
      });

      if (options.simulateCrashBeforeAck) {
        this.logger.warn("SQS_SIMULATED_CRASH_BEFORE_ACK", "Simulating worker crash after commit and before ACK", {
          correlationId,
          messageId,
        });
        if (receiptHandle) {
          await this.sqsService.changeMessageVisibility(WAGER_TRANSACTIONS_QUEUE, receiptHandle, 0);
        }
        throw new Error("Simulated worker crash after DB commit and before SQS ACK.");
      }

      // ACK ONLY after database transaction has committed
      if (receiptHandle) {
        await this.sqsService.deleteMessage(WAGER_TRANSACTIONS_QUEUE, receiptHandle);
      }
    } catch (error) {
      if (options.simulateCrashBeforeAck) {
        throw error;
      }

      // Permanent domain/contract errors cannot succeed on retry -> move to DLQ
      if (this.isPermanentError(error)) {
        const reason = error instanceof DomainError ? error.code : "PERMANENT_CONTRACT_ERROR";
        await this.moveToDlq(msg, reason, error, correlationId, messageId);
        return;
      }

      // Transient error: check retry limit
      if (receiveCount >= SqsWagerConsumerWorker.MAX_RECEIVE_ATTEMPTS) {
        await this.moveToDlq(msg, "MAX_RETRIES_EXHAUSTED", error, correlationId, messageId);
        return;
      }

      // Schedule retry with exponential backoff via visibility timeout
      this.metrics.incrementRetries();
      const backoffSeconds = Math.min(30, Math.pow(2, receiveCount));
      this.logger.warn("SQS_TRANSIENT_ERROR_RETRY", "Transient error processing SQS message; backing off", {
        correlationId,
        messageId,
        receiveCount,
        backoffSeconds,
        error: error instanceof Error ? error.message : String(error),
      });

      if (receiptHandle) {
        await this.sqsService.changeMessageVisibility(
          WAGER_TRANSACTIONS_QUEUE,
          receiptHandle,
          backoffSeconds,
        );
      }
    }
  }

  private isPermanentError(error: unknown): boolean {
    return (
      error instanceof InvalidAmountError ||
      error instanceof InvalidTransactionKindError ||
      error instanceof InvalidReferenceError ||
      error instanceof IdempotencyConflictError ||
      error instanceof WalletNotFoundError
    );
  }

  private async moveToDlq(
    msg: Message,
    reason: string,
    error: unknown,
    correlationId: string,
    messageId?: string,
  ): Promise<void> {
    const dlqPayload = {
      originalMessageId: messageId ?? msg.MessageId ?? uuidv7(),
      reason,
      errorMessage: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
      rawBody: msg.Body,
    };

    const dedupId = messageId ?? msg.MessageId ?? uuidv7();
    await this.sqsService.sendFifoMessage(
      WAGER_TRANSACTIONS_DLQ,
      JSON.stringify(dlqPayload),
      "dlq-group",
      `dlq-${dedupId}`,
    );

    if (msg.ReceiptHandle) {
      await this.sqsService.deleteMessage(WAGER_TRANSACTIONS_QUEUE, msg.ReceiptHandle);
    }

    this.metrics.incrementDlqMessages();
    this.logger.error("SQS_MESSAGE_MOVED_TO_DLQ", `Message moved to DLQ: ${reason}`, {
      correlationId,
      messageId: dedupId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
