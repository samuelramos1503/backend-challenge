import { describe, expect, it } from "bun:test";
import { WagerTransactionProcessed } from "../../src/domain/events/wager-transaction-processed.event";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.event";
import { InboxMessage } from "../../src/domain/models/inbox-message.entity";
import { Money } from "../../src/domain/models/money.vo";
import { OutboxMessage } from "../../src/domain/models/outbox-message.entity";
import { WagerTransaction, WagerTransactionKind } from "../../src/domain/models/wager-transaction.entity";
import { Wallet } from "../../src/domain/models/wallet.aggregate";

describe("Inbox, Outbox and Integration Events", () => {
  it("should track InboxMessage receive and processed transitions", () => {
    const inbox = InboxMessage.receive({
      consumerName: "sqs-wager-consumer",
      messageId: "msg-001",
      payloadHash: "hash-001",
    });

    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(new Date("2026-10-30T12:00:00.000Z"));
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.toISOString()).toBe("2026-10-30T12:00:00.000Z");
  });

  it("should serialize IntegrationEvent and manage OutboxMessage retry backoff", () => {
    const { wallet } = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const { entry } = wallet.debit(
      Money.from({ amount: "25.00", currency: "BRL" }),
      "tx-1",
      "entry-1",
    );

    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: "ev-1",
      correlationId: "corr-1",
      causationId: "tx-1",
    });

    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.eventType).toBe("WalletBalanceChanged");
    expect(outbox.payload.version).toBe(1);

    const now = new Date("2026-10-30T12:00:00.000Z");
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(outbox.isDue(now)).toBe(false);

    outbox.markPublished(now);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(now)).toBe(false);
  });

  it("should serialize WagerTransactionProcessed with decimal string MoneyProps", () => {
    const tx = WagerTransaction.create({
      id: "tx-ev-1",
      providerId: "prov-a",
      externalTransactionId: "ext-ev-1",
      idempotencyKey: "prov-a:ext-ev-1",
      payloadHash: "hash-ev-1",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "15.50", currency: "BRL" }),
    });
    tx.markProcessed(undefined);

    const ev = WagerTransactionProcessed.from(tx, {
      eventId: "ev-2",
      correlationId: "corr-2",
    });

    const json = ev.toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.data.money).toEqual({ amount: "15.50", currency: "BRL" });
  });
});
