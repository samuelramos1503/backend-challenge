import { Injectable } from "@nestjs/common";

export interface MetricsSnapshot {
  transactionsByStatus: Record<string, number>;
  duplicatesDetected: number;
  retriesTotal: number;
  dlqMessagesTotal: number;
  lockConflictsTotal: number;
  reconciliationDivergencesTotal: number;
  outboxLagMs: number;
  outboxPendingCount: number;
  processingLatencyMs: {
    count: number;
    sumMs: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
}

@Injectable()
export class MetricsService {
  private readonly transactionsByStatus: Record<string, number> = {
    PROCESSED: 0,
    REJECTED: 0,
    PENDING_REFERENCE: 0,
    FAILED: 0,
  };
  private duplicatesDetected = 0;
  private retriesTotal = 0;
  private dlqMessagesTotal = 0;
  private lockConflictsTotal = 0;
  private reconciliationDivergencesTotal = 0;
  private outboxLagMs = 0;
  private outboxPendingCount = 0;
  private readonly latencySamples: number[] = [];
  private static readonly MAX_SAMPLES = 5000;

  public incrementTransactionStatus(status: string): void {
    this.transactionsByStatus[status] = (this.transactionsByStatus[status] ?? 0) + 1;
  }

  public incrementDuplicatesDetected(): void {
    this.duplicatesDetected += 1;
  }

  public incrementRetries(): void {
    this.retriesTotal += 1;
  }

  public incrementDlqMessages(): void {
    this.dlqMessagesTotal += 1;
  }

  public incrementLockConflicts(): void {
    this.lockConflictsTotal += 1;
  }

  public incrementReconciliationDivergences(): void {
    this.reconciliationDivergencesTotal += 1;
  }

  public setOutboxLag(lagMs: number, pendingCount: number): void {
    this.outboxLagMs = Math.max(0, Math.round(lagMs));
    this.outboxPendingCount = Math.max(0, pendingCount);
  }

  public recordProcessingLatency(durationMs: number): void {
    if (this.latencySamples.length >= MetricsService.MAX_SAMPLES) {
      this.latencySamples.shift();
    }
    this.latencySamples.push(Math.max(0, durationMs));
  }

  public getSnapshot(): MetricsSnapshot {
    const samples = [...this.latencySamples].sort((a, b) => a - b);
    const count = samples.length;
    const sumMs = samples.reduce((acc, v) => acc + v, 0);
    const avgMs = count > 0 ? Number((sumMs / count).toFixed(2)) : 0;
    const minMs = count > 0 ? samples[0] : 0;
    const maxMs = count > 0 ? samples[count - 1] : 0;
    const percentile = (p: number): number => {
      if (count === 0) return 0;
      const idx = Math.min(count - 1, Math.floor((p / 100) * count));
      return Number(samples[idx].toFixed(2));
    };

    return {
      transactionsByStatus: { ...this.transactionsByStatus },
      duplicatesDetected: this.duplicatesDetected,
      retriesTotal: this.retriesTotal,
      dlqMessagesTotal: this.dlqMessagesTotal,
      lockConflictsTotal: this.lockConflictsTotal,
      reconciliationDivergencesTotal: this.reconciliationDivergencesTotal,
      outboxLagMs: this.outboxLagMs,
      outboxPendingCount: this.outboxPendingCount,
      processingLatencyMs: {
        count,
        sumMs: Number(sumMs.toFixed(2)),
        avgMs,
        minMs: Number(minMs.toFixed(2)),
        maxMs: Number(maxMs.toFixed(2)),
        p50Ms: percentile(50),
        p95Ms: percentile(95),
        p99Ms: percentile(99),
      },
    };
  }
}
