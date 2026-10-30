import { createHash } from "crypto";
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
      const parsed = JSON.parse(msg.Body || "{}");
      envelope = this.validateEnvelope(parsed);
    } catch (parseError) {
      // Malformed JSON or invalid envelope schema is permanent -> move to DLQ immediately
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

      if (process.env.CRASH_AFTER_COMMIT_BEFORE_ACK === "true") {
        if (receiptHandle) {
          await this.sqsService.changeMessageVisibility(WAGER_TRANSACTIONS_QUEUE, receiptHandle, 0);
        }
        process.exit(137);
      }

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

  private validateEnvelope(raw: unknown): SqsWagerMessageEnvelope {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid SQS message envelope: root must be a JSON object.");
    }

    const obj = raw as Record<string, unknown>;
    if (typeof obj.messageId !== "string" || obj.messageId.trim() === "" || obj.messageId.length > 255) {
      throw new Error("Invalid SQS message envelope: messageId must be a non-empty string (max 255 chars).");
    }

    if (obj.type !== "WagerTransactionRequested") {
      throw new Error(`Unsupported SQS message type: '${String(obj.type)}'. Expected 'WagerTransactionRequested'.`);
    }

    if (typeof obj.occurredAt !== "string" || Number.isNaN(Date.parse(obj.occurredAt))) {
      throw new Error(`Invalid SQS message envelope: occurredAt '${String(obj.occurredAt)}' is not a valid ISO-8601 timestamp.`);
    }

    if (!obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)) {
      throw new Error("Invalid SQS message envelope: data must be a JSON object.");
    }

    const data = obj.data as Record<string, unknown>;
    const requiredDataStrings = [
      "providerId",
      "externalTransactionId",
      "playerId",
      "walletId",
      "roundId",
      "gameId",
      "kind",
    ];
    for (const field of requiredDataStrings) {
      if (typeof data[field] !== "string" || (data[field] as string).trim() === "") {
        throw new Error(`Invalid SQS message envelope: data.${field} must be a non-empty string.`);
      }
    }

    if (data.idempotencyKey !== undefined && data.idempotencyKey !== null) {
      if (typeof data.idempotencyKey !== "string" || data.idempotencyKey.trim() === "") {
        throw new Error("Invalid SQS message envelope: data.idempotencyKey must be a non-empty string when provided.");
      }
    }

    if (
      data.referenceExternalTransactionId !== undefined &&
      data.referenceExternalTransactionId !== null
    ) {
      if (
        typeof data.referenceExternalTransactionId !== "string" ||
        data.referenceExternalTransactionId.trim() === ""
      ) {
        throw new Error(
          "Invalid SQS message envelope: data.referenceExternalTransactionId must be a non-empty string when provided.",
        );
      }
    }

    if (!data.money || typeof data.money !== "object" || Array.isArray(data.money)) {
      throw new Error("Invalid SQS message envelope: data.money must be a JSON object.");
    }

    const money = data.money as Record<string, unknown>;
    if (typeof money.amount !== "string" || typeof money.currency !== "string") {
      throw new Error("Invalid SQS message envelope: data.money.amount and currency must be strings.");
    }

    return {
      messageId: obj.messageId,
      type: obj.type,
      occurredAt: obj.occurredAt,
      data: {
        providerId: data.providerId as string,
        externalTransactionId: data.externalTransactionId as string,
        idempotencyKey: (data.idempotencyKey as string | undefined) ?? undefined,
        playerId: data.playerId as string,
        walletId: data.walletId as string,
        roundId: data.roundId as string,
        gameId: data.gameId as string,
        kind: data.kind as string,
        money: {
          amount: money.amount,
          currency: money.currency,
        },
        referenceExternalTransactionId:
          (data.referenceExternalTransactionId as string | undefined) ?? undefined,
      },
    };
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

    const dedupSource = messageId ?? msg.MessageId ?? uuidv7();
    const dedupHash = createHash("sha256").update(dedupSource).digest("hex");
    await this.sqsService.sendFifoMessage(
      WAGER_TRANSACTIONS_DLQ,
      JSON.stringify(dlqPayload),
      "dlq-group",
      `dlq-${dedupHash}`,
    );

    if (msg.ReceiptHandle) {
      await this.sqsService.deleteMessage(WAGER_TRANSACTIONS_QUEUE, msg.ReceiptHandle);
    }

    this.metrics.incrementDlqMessages();
    this.logger.error("SQS_MESSAGE_MOVED_TO_DLQ", `Message moved to DLQ: ${reason}`, {
      correlationId,
      messageId: dedupSource,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
