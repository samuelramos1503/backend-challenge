import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { OutboxMessage } from "../../domain/models/outbox-message.entity";
import { MikroOrmOutboxRepository } from "../database/repositories/mikro-orm-outbox.repository";
import { MetricsService } from "../observability/metrics.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { SqsService, WAGERING_EVENTS_QUEUE } from "./sqs.service";

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private isShuttingDown = false;
  private activeBatchPromise: Promise<number> | null = null;
  private publishedEventsLog: OutboxMessage[] = [];

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsService) private readonly sqsService: SqsService,
    @Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public onModuleInit(): void {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") {
      return;
    }
    const intervalMs = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || "500", 10);
    this.timer = setInterval(() => {
      if (!this.isShuttingDown && !this.activeBatchPromise) {
        this.activeBatchPromise = this.processBatch()
          .catch((err) => {
            this.logger.error("OUTBOX_WORKER_ERROR", "Error processing outbox batch", {
              error: err instanceof Error ? err.message : String(err),
            });
            return 0;
          })
          .finally(() => {
            this.activeBatchPromise = null;
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
    if (this.activeBatchPromise) {
      await this.activeBatchPromise;
    }
  }

  /**
   * Claims a batch of due outbox messages using SELECT ... FOR UPDATE SKIP LOCKED
   * inside a transaction so concurrent publishers never process the same rows.
   */
  public async processBatch(limit = 25): Promise<number> {
    const publishedCount = await this.em.transactional(async (txEm) => {
      const outboxRepo = new MikroOrmOutboxRepository(txEm);
      const messages = await outboxRepo.findDueMessages(limit);

      let count = 0;
      const now = new Date();

      for (const message of messages) {
        try {
          await this.sqsService.sendFifoMessage(
            WAGERING_EVENTS_QUEUE,
            JSON.stringify(message.payload),
            message.aggregateId,
            message.id,
          );

          await outboxRepo.markPublished(message.id, now);
          message.markPublished(now);
          this.publishedEventsLog.push(message);
          count += 1;

          this.logger.info("OUTBOX_EVENT_PUBLISHED", `Published ${message.eventType}`, {
            eventId: message.id,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
          });
        } catch (error) {
          await outboxRepo.scheduleRetry(message.id, now);
          this.metrics.incrementRetries();
          this.logger.warn("OUTBOX_PUBLISH_RETRY", `Failed to publish outbox event ${message.id}; scheduled retry`, {
            eventId: message.id,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            attempts: message.attempts + 1,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return count;
    });

    await this.updateOutboxLagMetrics();
    return publishedCount;
  }

  public getPublishedEventsLog(): ReadonlyArray<OutboxMessage> {
    return this.publishedEventsLog;
  }

  public clearPublishedEventsLog(): void {
    this.publishedEventsLog = [];
  }

  private async updateOutboxLagMetrics(): Promise<void> {
    try {
      const conn = this.em.getConnection();
      const rows = await conn.execute<{ pending_count: string; oldest_occurred_at: string | null }[]>(
        `SELECT COUNT(*) AS pending_count, MIN(occurred_at) AS oldest_occurred_at
         FROM outbox_messages
         WHERE published_at IS NULL`,
      );
      const row = rows[0];
      const pendingCount = parseInt(row?.pending_count || "0", 10);
      const lagMs =
        pendingCount > 0 && row?.oldest_occurred_at
          ? Math.max(0, Date.now() - new Date(row.oldest_occurred_at).getTime())
          : 0;
      this.metrics.setOutboxLag(lagMs, pendingCount);
    } catch {
      // Ignore metrics query errors during shutdown
    }
  }
}
