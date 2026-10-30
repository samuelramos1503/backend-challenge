import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import {
  assertWalletLedgerInvariant,
  createTestAppInstance,
  resetDatabaseAndQueues,
  TestAppInstance,
} from "../helpers/test-cluster.helper";

describe("Load & Stress Test — Distributed Wagering Processor", () => {
  let instance: TestAppInstance;

  beforeAll(async () => {
    instance = await createTestAppInstance();
    await resetDatabaseAndQueues(instance);
  });

  afterAll(async () => {
    if (instance?.app) {
      await instance.app.close();
    }
  });

  it("should sustain high concurrent load across 20 wallets (400 transactions) with zero financial drift", async () => {
    const walletCount = 20;
    const opsPerWallet = 20;
    const totalOps = walletCount * opsPerWallet;

    const wallets = await Promise.all(
      Array.from({ length: walletCount }, (_, i) =>
        fetch(`${instance.baseUrl}/wallets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            playerId: `load-player-${i}`,
            initialBalance: { amount: "1000.00", currency: "BRL" },
          }),
        }).then((r) => r.json()),
      ),
    );

    const startTime = performance.now();

    const results = await Promise.all(
      wallets.flatMap((w, wIdx) =>
        Array.from({ length: opsPerWallet }, (_, opIdx) =>
          fetch(`${instance.baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `load-prov:w-${wIdx}-op-${opIdx}`,
            },
            body: JSON.stringify({
              providerId: "load-prov",
              externalTransactionId: `w-${wIdx}-op-${opIdx}`,
              playerId: `load-player-${wIdx}`,
              walletId: w.id,
              roundId: `load-round-${opIdx}`,
              gameId: "fortune-chimp",
              kind: opIdx % 2 === 0 ? "BET" : "WIN",
              money: { amount: "10.00", currency: "BRL" },
            }),
          }),
        ),
      ),
    );

    const totalDurationMs = performance.now() - startTime;
    const rps = Number(((totalOps / totalDurationMs) * 1000).toFixed(2));
    const errorCount = results.filter((r) => r.status >= 500).length;

    await instance.outboxWorker.processBatch(1000);

    const metrics = instance.app.get(MetricsService).getSnapshot();

    console.log("\n==========================================");
    console.log("LOAD TEST BENCHMARK SUMMARY");
    console.log("==========================================");
    console.log(`Total Operations : ${totalOps}`);
    console.log(`Total Wallets    : ${walletCount}`);
    console.log(`Total Duration   : ${totalDurationMs.toFixed(2)} ms`);
    console.log(`Throughput (RPS) : ${rps} req/s`);
    console.log(`5xx Error Rate   : ${errorCount} (0.00%)`);
    console.log(`Latency p50      : ${metrics.processingLatencyMs.p50Ms} ms`);
    console.log(`Latency p95      : ${metrics.processingLatencyMs.p95Ms} ms`);
    console.log(`Latency p99      : ${metrics.processingLatencyMs.p99Ms} ms`);
    console.log(`Lock Conflicts   : ${metrics.lockConflictsTotal}`);
    console.log(`Outbox Lag       : ${metrics.outboxLagMs} ms`);
    console.log("==========================================\n");

    expect(errorCount).toBe(0);

    for (const w of wallets) {
      await assertWalletLedgerInvariant(instance, w.id);
    }
  }, 60000);
});
