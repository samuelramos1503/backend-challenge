import { spawn } from "child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import { WAGER_TRANSACTIONS_QUEUE } from "../../src/infrastructure/messaging/sqs.service";
import {
  assertWalletLedgerInvariant,
  createTestAppInstance,
  resetDatabaseAndQueues,
  TestAppInstance,
} from "../helpers/test-cluster.helper";

describe("Concurrency Tests — Real Parallelism, Multi-Instance Cluster & Fault Recovery", () => {
  let app1: TestAppInstance;
  let app2: TestAppInstance;
  let app3: TestAppInstance;

  beforeAll(async () => {
    app1 = await createTestAppInstance();
    app2 = await createTestAppInstance();
    app3 = await createTestAppInstance();
  });

  afterAll(async () => {
    await Promise.all([
      app1?.app?.close(),
      app2?.app?.close(),
      app3?.app?.close(),
    ]);
  });

  beforeEach(async () => {
    await resetDatabaseAndQueues(app1);
  });

  it("1. Same bet sent 50 times in parallel -> exactly one debit and 49 idempotent replays", async () => {
    const createRes = await fetch(`${app1.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-50x",
        initialBalance: { amount: "500.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    const payload = JSON.stringify({
      providerId: "provider-50x",
      externalTransactionId: "tx-50x-1",
      playerId: "player-50x",
      walletId: wallet.id,
      roundId: "round-50x",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });

    const urls = [app1.baseUrl, app2.baseUrl, app3.baseUrl];
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, idx) =>
        fetch(`${urls[idx % urls.length]}/wagering/transactions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "provider-50x:tx-50x-1",
          },
          body: payload,
        }).then((r) => r.json()),
      ),
    );

    const processedCount = responses.filter((r) => r.status === "PROCESSED").length;
    const originalExecutions = responses.filter((r) => r.idempotentReplay === false).length;
    const replays = responses.filter((r) => r.idempotentReplay === true).length;

    expect(processedCount).toBe(50);
    expect(originalExecutions).toBe(1);
    expect(replays).toBe(49);

    for (const res of responses) {
      expect(res.balance.amount).toBe("475.00");
    }

    const ledgerRes = await (await fetch(`${app1.baseUrl}/wallets/${wallet.id}/ledger`)).json();
    // 1 OPENING + 1 DEBIT = 2 entries total
    expect(ledgerRes.entries.length).toBe(2);

    await assertWalletLedgerInvariant(app1, wallet.id);
  });

  it("2. Mandatory Section 8 Scenario: 100.00 BRL balance, two simultaneous 80.00 BRL bets -> 1 PROCESSED, 1 REJECTED, 20.00 BRL final balance", async () => {
    const createRes = await fetch(`${app1.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-race-80",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    const [resA, resB] = await Promise.all([
      fetch(`${app1.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "provider-race:bet-a",
        },
        body: JSON.stringify({
          providerId: "provider-race",
          externalTransactionId: "bet-a",
          playerId: "player-race-80",
          walletId: wallet.id,
          roundId: "round-race-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => ({ httpStatus: r.status, body: await r.json() })),

      fetch(`${app2.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "provider-race:bet-b",
        },
        body: JSON.stringify({
          providerId: "provider-race",
          externalTransactionId: "bet-b",
          playerId: "player-race-80",
          walletId: wallet.id,
          roundId: "round-race-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => ({ httpStatus: r.status, body: await r.json() })),
    ]);

    const statuses = [resA.body.status, resB.body.status].sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);

    const rejected = resA.body.status === "REJECTED" ? resA.body : resB.body;
    expect(rejected.failureCode).toBe("INSUFFICIENT_FUNDS");

    const finalWallet = await (await fetch(`${app1.baseUrl}/wallets/${wallet.id}`)).json();
    expect(finalWallet.balance.amount).toBe("20.00");

    const ledger = await (await fetch(`${app1.baseUrl}/wallets/${wallet.id}/ledger`)).json();
    const debitEntries = ledger.entries.filter((e: { direction: string }) => e.direction === "DEBIT");
    expect(debitEntries.length).toBe(1);

    await assertWalletLedgerInvariant(app1, wallet.id);
  });

  it("3 & 4. Parallel operations across multiple distinct wallets and >= 3 simultaneous instances on a hot wallet", async () => {
    const urls = [app1.baseUrl, app2.baseUrl, app3.baseUrl];

    // Create 5 distinct wallets in parallel across the 3 instances
    const wallets = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(`${urls[i % urls.length]}/wallets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            playerId: `player-multi-${i}`,
            initialBalance: { amount: "300.00", currency: "BRL" },
          }),
        }).then((r) => r.json()),
      ),
    );

    // Fire 10 concurrent operations per wallet (50 total) distributed across the 3 instances
    await Promise.all(
      wallets.flatMap((w, wIdx) =>
        Array.from({ length: 10 }, (_, opIdx) =>
          fetch(`${urls[(wIdx + opIdx) % urls.length]}/wagering/transactions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `prov-m:w-${wIdx}-op-${opIdx}`,
            },
            body: JSON.stringify({
              providerId: "prov-m",
              externalTransactionId: `w-${wIdx}-op-${opIdx}`,
              playerId: `player-multi-${wIdx}`,
              walletId: w.id,
              roundId: `round-${opIdx}`,
              gameId: "fortune-chimp",
              kind: opIdx % 2 === 0 ? "BET" : "WIN",
              money: { amount: "20.00", currency: "BRL" },
            }),
          }),
        ),
      ),
    );

    for (const w of wallets) {
      await assertWalletLedgerInvariant(app1, w.id);
      const updated = await (await fetch(`${app1.baseUrl}/wallets/${w.id}`)).json();
      expect(updated.balance.amount).toBe("300.00"); // 5 BETs of 20 and 5 WINs of 20
      expect(updated.version).toBe(11); // 1 initial + 10 balance movements
    }
  });

  it("5. Worker crash after DB commit and before SQS ACK -> redelivery is deduplicated via Inbox without double debit", async () => {
    const createRes = await fetch(`${app1.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-crash-ack",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    const msgId = `msg-crash-${uuidv7()}`;
    const envelope = {
      messageId: msgId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "prov-crash",
        externalTransactionId: "tx-crash-1",
        idempotencyKey: "prov-crash:tx-crash-1",
        playerId: "player-crash-ack",
        walletId: wallet.id,
        roundId: "round-crash",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "40.00", currency: "BRL" },
      },
    };

    await app1.sqsService.sendFifoMessage(
      WAGER_TRANSACTIONS_QUEUE,
      JSON.stringify(envelope),
      wallet.id,
      `dedup-crash-${uuidv7()}`,
    );

    // Worker 1 crashes right after DB commit and before ACK
    let crashed = false;
    try {
      await app1.sqsConsumer.pollOnce({ simulateCrashBeforeAck: true });
    } catch {
      crashed = true;
    }
    expect(crashed).toBe(true);

    // Worker 2 picks up the redelivered message from SQS
    const secondPollCount = await app2.sqsConsumer.pollOnce();
    expect(secondPollCount).toBe(1);

    const finalWallet = await (await fetch(`${app1.baseUrl}/wallets/${wallet.id}`)).json();
    expect(finalWallet.balance.amount).toBe("60.00");

    await assertWalletLedgerInvariant(app1, wallet.id);
  });

  it("6. Two concurrent publishers over the same Outbox -> SKIP LOCKED prevents duplicate publishing", async () => {
    const createRes = await fetch(`${app1.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-outbox-race",
        initialBalance: { amount: "500.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    // Generate 10 bets -> 20 outbox messages (+ 2 from wallet opening = 22 total)
    for (let i = 0; i < 10; i++) {
      await fetch(`${app1.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `prov-ob:tx-${i}`,
        },
        body: JSON.stringify({
          providerId: "prov-ob",
          externalTransactionId: `tx-${i}`,
          playerId: "player-outbox-race",
          walletId: wallet.id,
          roundId: `round-${i}`,
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        }),
      });
    }

    app1.outboxWorker.clearPublishedEventsLog();
    app2.outboxWorker.clearPublishedEventsLog();

    const [count1, count2] = await Promise.all([
      app1.outboxWorker.processBatch(15),
      app2.outboxWorker.processBatch(15),
    ]);

    expect(count1 + count2).toBe(22);

    const ids1 = new Set(app1.outboxWorker.getPublishedEventsLog().map((e) => e.id));
    const ids2 = new Set(app2.outboxWorker.getPublishedEventsLog().map((e) => e.id));
    for (const id of ids1) {
      expect(ids2.has(id)).toBe(false);
    }

    await assertWalletLedgerInvariant(app1, wallet.id);
  });

  it("7 & 8. Out-of-order REFUND delivered before BET -> PENDING_REFERENCE resolved after BET arrives & service restart consistency", async () => {
    const createRes = await fetch(`${app1.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-ooo",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    // 1. REFUND arrives BEFORE the referenced BET
    const refundRes = await fetch(`${app1.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-ooo:refund-early",
      },
      body: JSON.stringify({
        providerId: "prov-ooo",
        externalTransactionId: "refund-early",
        playerId: "player-ooo",
        walletId: wallet.id,
        roundId: "round-ooo-1",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "40.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-late",
      }),
    });
    expect(refundRes.status).toBe(202);
    const refundBody = await refundRes.json();
    expect(refundBody.status).toBe("PENDING_REFERENCE");

    // 2. Now the referenced BET arrives -> balance drops from 100.00 to 60.00 BRL
    const betRes = await fetch(`${app1.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-ooo:bet-late",
      },
      body: JSON.stringify({
        providerId: "prov-ooo",
        externalTransactionId: "bet-late",
        playerId: "player-ooo",
        walletId: wallet.id,
        roundId: "round-ooo-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "40.00", currency: "BRL" },
      }),
    });
    expect(betRes.status).toBe(200);

    // 3. Simulate restart / new instance picking up due pending reference transactions
    await app1.em
      .getConnection()
      .execute(`UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = ?`, [
        refundBody.transactionId,
      ]);

    const restartedInstance = await createTestAppInstance();
    try {
      const resolved = await restartedInstance.pendingRefWorker.processDuePendingReferences();
      expect(resolved).toBe(1);

      const txStatus = await (
        await fetch(`${restartedInstance.baseUrl}/wagering/transactions/${refundBody.transactionId}`)
      ).json();
      expect(txStatus.status).toBe("PROCESSED");

      const finalWallet = await (
        await fetch(`${restartedInstance.baseUrl}/wallets/${wallet.id}`)
      ).json();
      expect(finalWallet.balance.amount).toBe("100.00");

      await assertWalletLedgerInvariant(restartedInstance, wallet.id);
    } finally {
      await restartedInstance.app.close();
    }
  });

  it("9. Concurrent PendingReferenceWorkers across 3 instances do not consume multiple retry attempts in the same backoff cycle", async () => {
    const createRes = await fetch(`${app1.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-pending-race",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    const refundRes = await fetch(`${app1.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-pr:refund-race",
      },
      body: JSON.stringify({
        providerId: "prov-pr",
        externalTransactionId: "refund-race",
        playerId: "player-pending-race",
        walletId: wallet.id,
        roundId: "round-pr-1",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "20.00", currency: "BRL" },
        referenceExternalTransactionId: "missing-bet-pr",
      }),
    });
    const refundBody = await refundRes.json();
    expect(refundBody.status).toBe("PENDING_REFERENCE");

    // Make the pending reference transaction due right now
    await app1.em
      .getConnection()
      .execute(`UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = ?`, [
        refundBody.transactionId,
      ]);

    // Trigger 3 workers simultaneously in the same cycle
    await Promise.all([
      app1.pendingRefWorker.processDuePendingReferences(),
      app2.pendingRefWorker.processDuePendingReferences(),
      app3.pendingRefWorker.processDuePendingReferences(),
    ]);

    const txAfter = await (
      await fetch(`${app1.baseUrl}/wagering/transactions/${refundBody.transactionId}`)
    ).json();
    expect(txAfter.status).toBe("PENDING_REFERENCE");
    expect(txAfter.retryAttempts).toBe(1);

    await assertWalletLedgerInvariant(app1, wallet.id);
  });

  it("10. Concurrent bet committing between wallet read and ledger sum during reconciliation does not cause false divergence", async () => {
    const createRes = await fetch(`${app1.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-recon-race",
        initialBalance: { amount: "90.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    const { MikroOrmWalletLedgerRepository } = await import(
      "../../src/infrastructure/database/repositories/mikro-orm-wallet-ledger.repository"
    );
    const origReconcile = MikroOrmWalletLedgerRepository.prototype.reconcileWallet;

    let concurrentBetPromise: Promise<Response> | null = null;
    MikroOrmWalletLedgerRepository.prototype.reconcileWallet = async function (
      walletId: string,
      currency: string,
    ) {
      // Controlled pause after wallet row was read: commit a 10.00 BRL bet on another connection before summing ledger
      concurrentBetPromise = fetch(`${app2.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "prov-recon-race:bet-10",
        },
        body: JSON.stringify({
          providerId: "prov-recon-race",
          externalTransactionId: "bet-10",
          playerId: "player-recon-race",
          walletId,
          roundId: "round-recon-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "10.00", currency },
        }),
      });
      await concurrentBetPromise;
      return origReconcile.call(this, walletId, currency);
    };

    try {
      const reconRes = await fetch(`${app1.baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: "POST",
      });
      expect(reconRes.status).toBe(200);
      const reconBody = await reconRes.json();
      expect(reconBody.consistent).toBe(true);
      expect(reconBody.difference.amount).toBe("0.00");
    } finally {
      MikroOrmWalletLedgerRepository.prototype.reconcileWallet = origReconcile;
    }

    await assertWalletLedgerInvariant(app1, wallet.id);
  });

  it("11. Real child OS process kill and restart preserves financial and ledger consistency", async () => {
    const childPort = 41987;
    const childProc = spawn("bun", ["run", "src/main.ts"], {
      env: {
        ...process.env,
        PORT: String(childPort),
        LOG_SILENT: "true",
        DISABLE_BACKGROUND_WORKERS: "true",
      },
      stdio: "ignore",
    });

    try {
      // Wait for child process HTTP server to become ready
      const childUrl = `http://127.0.0.1:${childPort}`;
      let ready = false;
      for (let i = 0; i < 40; i++) {
        try {
          const res = await fetch(`${childUrl}/health/live`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // still booting
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(ready).toBe(true);

      const createRes = await fetch(`${childUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: "player-real-kill",
          initialBalance: { amount: "200.00", currency: "BRL" },
        }),
      });
      const wallet = await createRes.json();

      const betRes = await fetch(`${childUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "prov-kill:bet-1",
        },
        body: JSON.stringify({
          providerId: "prov-kill",
          externalTransactionId: "bet-1",
          playerId: "player-real-kill",
          walletId: wallet.id,
          roundId: "round-kill-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "75.00", currency: "BRL" },
        }),
      });
      expect(betRes.status).toBe(200);

      // Abruptly kill the OS process
      childProc.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (childProc.exitCode !== null) return resolve();
        childProc.once("exit", () => resolve());
      });

      // Verify state from surviving cluster instance
      const replayRes = await fetch(`${app1.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "prov-kill:bet-1",
        },
        body: JSON.stringify({
          providerId: "prov-kill",
          externalTransactionId: "bet-1",
          playerId: "player-real-kill",
          walletId: wallet.id,
          roundId: "round-kill-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "75.00", currency: "BRL" },
        }),
      });
      const replayBody = await replayRes.json();
      expect(replayBody.idempotentReplay).toBe(true);
      expect(replayBody.balance.amount).toBe("125.00");

      // Now spawn a child worker process that crashes in the EXACT window after DB commit and before SQS ACK
      const sqsCrashMsgId = `msg-proc-crash-${uuidv7()}`;
      await app1.sqsService.sendFifoMessage(
        WAGER_TRANSACTIONS_QUEUE,
        JSON.stringify({
          messageId: sqsCrashMsgId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "prov-kill",
            externalTransactionId: "bet-sqs-kill-window",
            idempotencyKey: "prov-kill:bet-sqs-kill-window",
            playerId: "player-real-kill",
            walletId: wallet.id,
            roundId: "round-kill-2",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "25.00", currency: "BRL" },
          },
        }),
        wallet.id,
        `dedup-proc-crash-${uuidv7()}`,
      );

      const sqsCrashWorker = spawn("bun", ["run", "src/main.ts"], {
        env: {
          ...process.env,
          PORT: String(childPort + 1),
          LOG_SILENT: "true",
          DISABLE_BACKGROUND_WORKERS: "false",
          SQS_POLL_INTERVAL_MS: "100",
          CRASH_AFTER_COMMIT_BEFORE_ACK: "true",
        },
        stdio: "ignore",
      });

      const workerExitCode = await new Promise<number | null>((resolve) => {
        sqsCrashWorker.once("exit", (code) => resolve(code));
      });
      expect(workerExitCode).toBe(137);

      // Surviving cluster instance polls the un-ACKed redelivered message from SQS and deduplicates via Inbox
      const redeliveredCount = await app1.sqsConsumer.pollOnce();
      expect(redeliveredCount).toBe(1);

      const finalWallet = await (await fetch(`${app1.baseUrl}/wallets/${wallet.id}`)).json();
      expect(finalWallet.balance.amount).toBe("100.00"); // 200 - 75 - 25 = 100.00 (no double debit!)

      await assertWalletLedgerInvariant(app1, wallet.id);
    } finally {
      try {
        childProc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
  });
});
