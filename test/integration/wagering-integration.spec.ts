import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import {
  SqsService,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
  WAGERING_EVENTS_QUEUE,
} from "../../src/infrastructure/messaging/sqs.service";
import {
  assertWalletLedgerInvariant,
  createTestAppInstance,
  resetDatabaseAndQueues,
  TestAppInstance,
} from "../helpers/test-cluster.helper";

describe("Integration Tests — PostgreSQL + LocalStack SQS + Transactional Outbox", () => {
  let instance: TestAppInstance;

  beforeAll(async () => {
    instance = await createTestAppInstance();
  });

  afterAll(async () => {
    if (instance?.app) {
      await instance.app.close();
    }
  });

  beforeEach(async () => {
    await resetDatabaseAndQueues(instance);
  });

  it("should enforce schema constraints and append-only ledger triggers at the PostgreSQL engine level", async () => {
    // 1. Create wallet with 100.00 BRL
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-ddl-1",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(createRes.status).toBe(201);
    const wallet = await createRes.json();

    const conn = instance.em.getConnection();

    // 2. Verify CHECK (balance >= 0) prevents negative balance via direct SQL
    let negativeCheckFailed = false;
    try {
      await conn.execute(`UPDATE wallets SET balance = -0.01 WHERE id = ?`, [wallet.id]);
    } catch {
      negativeCheckFailed = true;
    }
    expect(negativeCheckFailed).toBe(true);

    // 3. Verify trg_prevent_ledger_update prevents UPDATE on wallet_ledger_entries
    let ledgerUpdateFailed = false;
    try {
      await conn.execute(`UPDATE wallet_ledger_entries SET amount = 999.00 WHERE wallet_id = ?`, [
        wallet.id,
      ]);
    } catch {
      ledgerUpdateFailed = true;
    }
    expect(ledgerUpdateFailed).toBe(true);

    // 4. Verify trg_prevent_ledger_delete prevents DELETE on wallet_ledger_entries
    let ledgerDeleteFailed = false;
    try {
      await conn.execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id]);
    } catch {
      ledgerDeleteFailed = true;
    }
    expect(ledgerDeleteFailed).toBe(true);

    // 5. Verify duplicate wallet for same playerId + currency returns 409 Conflict
    const dupRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-ddl-1",
        initialBalance: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(dupRes.status).toBe(409);

    await assertWalletLedgerInvariant(instance, wallet.id);
  });

  it("should execute BET, WIN, LOSS, REFUND, and ROLLBACK while preserving ledger invariants and observed balances on replay", async () => {
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-flow-1",
        initialBalance: { amount: "200.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    // 1. BET 50.00 BRL -> balance becomes 150.00 BRL
    const betRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:bet-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "bet-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(betRes.status).toBe(200);
    const betBody = await betRes.json();
    expect(betBody.status).toBe("PROCESSED");
    expect(betBody.balance.amount).toBe("150.00");
    expect(betBody.idempotentReplay).toBe(false);

    // 2. WIN 120.00 BRL referencing bet-1 -> balance becomes 270.00 BRL
    const winRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:win-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "win-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "WIN",
        money: { amount: "120.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-1",
      }),
    });
    expect(winRes.status).toBe(200);
    const winBody = await winRes.json();
    expect(winBody.balance.amount).toBe("270.00");

    // 3. Replay BET 1 after WIN 1 -> MUST return the balance observed when BET 1 was processed (150.00 BRL)
    const betReplayRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:bet-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "bet-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(betReplayRes.status).toBe(200);
    const betReplayBody = await betReplayRes.json();
    expect(betReplayBody.idempotentReplay).toBe(true);
    expect(betReplayBody.balance.amount).toBe("150.00");

    // 4. Same Idempotency-Key with different amount -> 409 Conflict
    const conflictRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:bet-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "bet-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "99.00", currency: "BRL" },
      }),
    });
    expect(conflictRes.status).toBe(409);

    // 5. LOSS does not change balance or wallet version
    const walletBeforeLoss = await (await fetch(`${instance.baseUrl}/wallets/${wallet.id}`)).json();
    const lossRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:loss-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "loss-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "LOSS",
        money: { amount: "0.00", currency: "BRL" },
      }),
    });
    expect(lossRes.status).toBe(200);
    const walletAfterLoss = await (await fetch(`${instance.baseUrl}/wallets/${wallet.id}`)).json();
    expect(walletAfterLoss.version).toBe(walletBeforeLoss.version);
    expect(walletAfterLoss.balance.amount).toBe("270.00");

    // 6. REFUND of bet-1 (50.00 BRL) -> balance becomes 320.00 BRL
    const refundRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:refund-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "refund-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-1",
      }),
    });
    expect(refundRes.status).toBe(200);
    const refundBody = await refundRes.json();
    expect(refundBody.balance.amount).toBe("320.00");

    // 7. Second REFUND of same bet-1 -> rejected with ALREADY_REVERSED (422)
    const dupRefundRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:refund-2",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "refund-2",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-1",
      }),
    });
    expect(dupRefundRes.status).toBe(422);
    const dupRefundBody = await dupRefundRes.json();
    expect(dupRefundBody.failureCode).toBe("ALREADY_REVERSED");

    // 8. Spend 250.00 BRL so balance is 70.00 BRL, then try to ROLLBACK win-1 (120.00 BRL)
    // Must be rejected with REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE (Rule 9)
    await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:bet-spend",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "bet-spend",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-2",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "250.00", currency: "BRL" },
      }),
    });

    const negRollbackRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-1:rollback-win-neg",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "rollback-win-neg",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "ROLLBACK",
        money: { amount: "120.00", currency: "BRL" },
        referenceExternalTransactionId: "win-1",
      }),
    });
    expect(negRollbackRes.status).toBe(422);
    const negRollbackBody = await negRollbackRes.json();
    expect(negRollbackBody.status).toBe("REJECTED");
    expect(negRollbackBody.failureCode).toBe("REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE");

    await assertWalletLedgerInvariant(instance, wallet.id);
  });

  it("should process SQS messages via Inbox, publish Outbox events, and route permanent failures to DLQ", async () => {
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-sqs-1",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    // 1. Enqueue valid SQS message
    const msgId = `msg-${uuidv7()}`;
    const validEnvelope = {
      messageId: msgId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "provider-sqs",
        externalTransactionId: "sqs-tx-1",
        idempotencyKey: "provider-sqs:sqs-tx-1",
        playerId: "player-sqs-1",
        walletId: wallet.id,
        roundId: "round-sqs-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "30.00", currency: "BRL" },
      },
    };

    await instance.sqsService.sendFifoMessage(
      WAGER_TRANSACTIONS_QUEUE,
      JSON.stringify(validEnvelope),
      wallet.id,
      `dedup-${uuidv7()}`,
    );

    const processedCount = await instance.sqsConsumer.pollOnce();
    expect(processedCount).toBe(1);

    // Redelivery of the exact same messageId -> deduplicated via Inbox
    await instance.sqsService.sendFifoMessage(
      WAGER_TRANSACTIONS_QUEUE,
      JSON.stringify(validEnvelope),
      wallet.id,
      `dedup-${uuidv7()}`,
    );
    await instance.sqsConsumer.pollOnce();

    const walletCheck = await (await fetch(`${instance.baseUrl}/wallets/${wallet.id}`)).json();
    expect(walletCheck.balance.amount).toBe("70.00");

    // 2. Publish pending Outbox events to wagering-events.fifo
    const publishedEvents = await instance.outboxWorker.processBatch(50);
    expect(publishedEvents).toBeGreaterThanOrEqual(4); // 2 from OPENING + 2 from BET

    const eventMessages = await instance.sqsService.receiveMessages(WAGERING_EVENTS_QUEUE, 10, 0, 5);
    expect(eventMessages.length).toBeGreaterThan(0);

    // 3. Send malformed message -> routed to DLQ
    await instance.sqsService.sendFifoMessage(
      WAGER_TRANSACTIONS_QUEUE,
      "{ malformed-json",
      wallet.id,
      `dedup-bad-${uuidv7()}`,
    );
    await instance.sqsConsumer.pollOnce();

    const dlqMessages = await instance.sqsService.receiveMessages(WAGER_TRANSACTIONS_DLQ, 10, 0, 5);
    expect(dlqMessages.length).toBe(1);

    await assertWalletLedgerInvariant(instance, wallet.id);
  });

  it("should detect ledger divergence during reconciliation without silently overwriting balance", async () => {
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-recon-1",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    // Tamper with stored balance directly in SQL to simulate data corruption
    await instance.em
      .getConnection()
      .execute(`UPDATE wallets SET balance = 125.00 WHERE id = ?`, [wallet.id]);

    const reconRes = await fetch(`${instance.baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    expect(reconRes.status).toBe(200);
    const reconBody = await reconRes.json();

    expect(reconBody.consistent).toBe(false);
    expect(reconBody.storedBalance.amount).toBe("125.00");
    expect(reconBody.calculatedBalance.amount).toBe("100.00");
    expect(reconBody.difference.amount).toBe("25.00");

    // Verify stored balance was NOT silently overwritten
    const afterWallet = await (await fetch(`${instance.baseUrl}/wallets/${wallet.id}`)).json();
    expect(afterWallet.balance.amount).toBe("125.00");
  });

  it("should preserve wallet currency on replay of CURRENCY_MISMATCH rejection and reject invalid currencies/amounts with 400", async () => {
    // 1. Invalid currency codes (ABCD, QQQ) and NUMERIC(18,2) overflow return 400 Bad Request, never 500
    for (const invalidBalance of [
      { amount: "100.00", currency: "ABCD" },
      { amount: "100.00", currency: "QQQ" },
      { amount: "10000000000000000.00", currency: "BRL" },
    ]) {
      const badWalletRes = await fetch(`${instance.baseUrl}/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: `player-bad-${invalidBalance.currency}`,
          initialBalance: invalidBalance,
        }),
      });
      expect(badWalletRes.status).toBe(400);
    }

    // 2. Open valid BRL wallet with 100.00 BRL
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-curr-mismatch",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(createRes.status).toBe(201);
    const wallet = await createRes.json();

    // 3. Submit USD bet against BRL wallet -> 422 REJECTED with 100.00 BRL balance
    const usdBetPayload = JSON.stringify({
      providerId: "prov-curr",
      externalTransactionId: "tx-usd-1",
      playerId: "player-curr-mismatch",
      walletId: wallet.id,
      roundId: "round-curr-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "15.00", currency: "USD" },
    });

    const firstRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-curr:tx-usd-1",
      },
      body: usdBetPayload,
    });
    expect(firstRes.status).toBe(422);
    const firstBody = await firstRes.json();
    expect(firstBody.status).toBe("REJECTED");
    expect(firstBody.failureCode).toBe("CURRENCY_MISMATCH");
    expect(firstBody.idempotentReplay).toBe(false);
    expect(firstBody.balance).toEqual({ amount: "100.00", currency: "BRL" });

    // 4. Replay the exact same USD bet -> must preserve observedBalance currency as BRL (not USD!)
    const replayRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-curr:tx-usd-1",
      },
      body: usdBetPayload,
    });
    expect(replayRes.status).toBe(422);
    const replayBody = await replayRes.json();
    expect(replayBody.status).toBe("REJECTED");
    expect(replayBody.failureCode).toBe("CURRENCY_MISMATCH");
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.balance).toEqual({ amount: "100.00", currency: "BRL" });

    await assertWalletLedgerInvariant(instance, wallet.id);
  });

  it("should reject Inbox replay when payload hash differs for the same messageId and idempotencyKey", async () => {
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-inbox-conflict",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    const sharedMessageId = `msg-conflict-${uuidv7()}`;
    const firstEnvelope = {
      messageId: sharedMessageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "prov-inbox",
        externalTransactionId: "tx-inbox-1",
        idempotencyKey: "prov-inbox:tx-inbox-1",
        playerId: "player-inbox-conflict",
        walletId: wallet.id,
        roundId: "round-inbox-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      },
    };

    await instance.sqsService.sendFifoMessage(
      WAGER_TRANSACTIONS_QUEUE,
      JSON.stringify(firstEnvelope),
      wallet.id,
      `dedup-1-${uuidv7()}`,
    );
    await instance.sqsConsumer.pollOnce();

    // Now send a mutated payload (20.00 instead of 10.00) with the SAME messageId and idempotencyKey
    const tamperedEnvelope = {
      ...firstEnvelope,
      data: {
        ...firstEnvelope.data,
        money: { amount: "20.00", currency: "BRL" },
      },
    };

    await instance.sqsService.sendFifoMessage(
      WAGER_TRANSACTIONS_QUEUE,
      JSON.stringify(tamperedEnvelope),
      wallet.id,
      `dedup-2-${uuidv7()}`,
    );
    await instance.sqsConsumer.pollOnce();

    // Must be routed to DLQ with IDEMPOTENCY_PAYLOAD_MISMATCH and balance must remain 90.00 BRL
    const dlqMessages = await instance.sqsService.receiveMessages(WAGER_TRANSACTIONS_DLQ, 10, 0, 5);
    expect(dlqMessages.length).toBe(1);
    const dlqBody = JSON.parse(dlqMessages[0].Body || "{}");
    expect(dlqBody.reason).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH");

    const walletAfter = await (await fetch(`${instance.baseUrl}/wallets/${wallet.id}`)).json();
    expect(walletAfter.balance.amount).toBe("90.00");

    await assertWalletLedgerInvariant(instance, wallet.id);
  });

  it("should verify live SQS readiness, atomic rollback on mid-transaction failure, and retry exhaustion", async () => {
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: "player-faults-1",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = await createRes.json();

    // 1. Live SQS check in /health/ready fails when SQS client cannot reach endpoint
    const readyOk = await fetch(`${instance.baseUrl}/health/ready`);
    expect(readyOk.status).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqsAny = instance.sqsService as any;
    const origSend = sqsAny.client.send.bind(sqsAny.client);
    sqsAny.client.send = async () => {
      throw new Error("Simulated SQS connection refused");
    };
    try {
      const readyDown = await fetch(`${instance.baseUrl}/health/ready`);
      expect(readyDown.status).toBe(503);
      const readyDownBody = await readyDown.json();
      expect(readyDownBody.status).toBe("degraded");
      expect(readyDownBody.dependencies.sqs).toBe("down");
    } finally {
      sqsAny.client.send = origSend;
    }

    // 2. Atomic rollback when an unexpected failure occurs between financial writes inside the DB transaction
    const { MikroOrmWalletLedgerRepository } = await import(
      "../../src/infrastructure/database/repositories/mikro-orm-wallet-ledger.repository"
    );
    const origLedgerSave = MikroOrmWalletLedgerRepository.prototype.save;
    MikroOrmWalletLedgerRepository.prototype.save = async function () {
      throw new Error("Simulated mid-transaction crash between wallet update and ledger insert");
    };
    try {
      const failedBetRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "prov-fault:bet-rollback-test",
        },
        body: JSON.stringify({
          providerId: "prov-fault",
          externalTransactionId: "bet-rollback-test",
          playerId: "player-faults-1",
          walletId: wallet.id,
          roundId: "round-fault-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "40.00", currency: "BRL" },
        }),
      });
      expect(failedBetRes.status).toBe(500);
    } finally {
      MikroOrmWalletLedgerRepository.prototype.save = origLedgerSave;
    }

    // Verify wallet balance, version, and ledger were completely rolled back
    const walletAfterRollback = await (await fetch(`${instance.baseUrl}/wallets/${wallet.id}`)).json();
    expect(walletAfterRollback.balance.amount).toBe("100.00");
    expect(walletAfterRollback.version).toBe(1);
    await assertWalletLedgerInvariant(instance, wallet.id);

    // 3. PENDING_REFERENCE retry exhaustion transitions to REJECTED (REFERENCE_NOT_FOUND) after 5 attempts
    const orphanRefundRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "prov-fault:orphan-refund",
      },
      body: JSON.stringify({
        providerId: "prov-fault",
        externalTransactionId: "orphan-refund",
        playerId: "player-faults-1",
        walletId: wallet.id,
        roundId: "round-fault-1",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "20.00", currency: "BRL" },
        referenceExternalTransactionId: "never-arriving-bet",
      }),
    });
    expect(orphanRefundRes.status).toBe(202);
    const orphanRefundBody = await orphanRefundRes.json();

    for (let attempt = 1; attempt <= 5; attempt++) {
      await instance.em
        .getConnection()
        .execute(`UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = ?`, [
          orphanRefundBody.transactionId,
        ]);
      await instance.pendingRefWorker.processDuePendingReferences();
    }

    const exhaustedTx = await (
      await fetch(`${instance.baseUrl}/wagering/transactions/${orphanRefundBody.transactionId}`)
    ).json();
    expect(exhaustedTx.status).toBe("REJECTED");
    expect(exhaustedTx.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(exhaustedTx.retryAttempts).toBe(5);

    await assertWalletLedgerInvariant(instance, wallet.id);
  });
});
