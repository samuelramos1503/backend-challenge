import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { MikroOrmWagerTransactionRepository } from "../database/repositories/mikro-orm-wager-transaction.repository";
import { StructuredLoggerService } from "../observability/structured-logger.service";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private isShuttingDown = false;
  private activePromise: Promise<number> | null = null;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(ProcessWagerTransactionUseCase) private readonly processUseCase: ProcessWagerTransactionUseCase,
    @Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService,
  ) {}

  public onModuleInit(): void {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") {
      return;
    }
    const intervalMs = parseInt(process.env.PENDING_REF_POLL_INTERVAL_MS || "500", 10);
    this.timer = setInterval(() => {
      if (!this.isShuttingDown && !this.activePromise) {
        this.activePromise = this.processDuePendingReferences()
          .catch((err) => {
            this.logger.error("PENDING_REF_WORKER_ERROR", "Error processing pending references", {
              error: err instanceof Error ? err.message : String(err),
            });
            return 0;
          })
          .finally(() => {
            this.activePromise = null;
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
    if (this.activePromise) {
      await this.activePromise;
    }
  }

  /**
   * Finds due PENDING_REFERENCE transactions and attempts to resolve them.
   */
  public async processDuePendingReferences(limit = 25): Promise<number> {
    const dueIds = await this.em.transactional(async (txEm) => {
      const repo = new MikroOrmWagerTransactionRepository(txEm);
      const dueTxs = await repo.findDuePendingReferences(limit);
      return dueTxs.map((t) => t.id);
    });

    let resolvedCount = 0;
    for (const txId of dueIds) {
      if (this.isShuttingDown) break;
      const res = await this.processUseCase.reprocessPendingTransaction(txId);
      if (res) {
        resolvedCount += 1;
      }
    }

    return resolvedCount;
  }
}
