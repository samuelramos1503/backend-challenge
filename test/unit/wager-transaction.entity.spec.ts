import { describe, expect, it } from "bun:test";
import { InvalidTransactionStateError } from "../../src/domain/errors/domain.error";
import { FailureCode } from "../../src/domain/models/failure-code.enum";
import { Money } from "../../src/domain/models/money.vo";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/models/wager-transaction.entity";
import { LedgerDirection } from "../../src/domain/models/wallet-ledger-entry.entity";

describe("WagerTransaction Entity", () => {
  const money = Money.from({ amount: "25.00", currency: "BRL" });

  it("should create a valid BET transaction in PENDING status", () => {
    const tx = WagerTransaction.create({
      id: "tx-1",
      providerId: "prov-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "prov-a:ext-1",
      payloadHash: "hash-123",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money,
    });

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  it("should enforce referenceExternalTransactionId for REFUND and ROLLBACK", () => {
    expect(() =>
      WagerTransaction.create({
        id: "tx-2",
        providerId: "prov-a",
        externalTransactionId: "ext-2",
        idempotencyKey: "prov-a:ext-2",
        payloadHash: "hash-456",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Refund,
        money,
      })
    ).toThrow();
  });

  it("should correctly handle state transitions to terminal states", () => {
    const tx = WagerTransaction.create({
      id: "tx-3",
      providerId: "prov-a",
      externalTransactionId: "ext-3",
      idempotencyKey: "prov-a:ext-3",
      payloadHash: "hash-789",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money,
    });

    tx.markProcessed(undefined);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);

    expect(() => tx.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.INTERNAL_ERROR)).toThrow(InvalidTransactionStateError);
  });

  it("should calculate correct ledger direction for ROLLBACK depending on reference", () => {
    const betTx = WagerTransaction.create({
      id: "tx-bet",
      providerId: "prov-a",
      externalTransactionId: "ext-bet",
      idempotencyKey: "prov-a:ext-bet",
      payloadHash: "hash-bet",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money,
    });

    const rollbackOfBet = WagerTransaction.create({
      id: "tx-rb-1",
      providerId: "prov-a",
      externalTransactionId: "ext-rb-1",
      idempotencyKey: "prov-a:ext-rb-1",
      payloadHash: "hash-rb-1",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Rollback,
      money,
      referenceExternalTransactionId: "ext-bet",
    });

    expect(rollbackOfBet.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);

    const winTx = WagerTransaction.create({
      id: "tx-win",
      providerId: "prov-a",
      externalTransactionId: "ext-win",
      idempotencyKey: "prov-a:ext-win",
      payloadHash: "hash-win",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Win,
      money,
    });

    const rollbackOfWin = WagerTransaction.create({
      id: "tx-rb-2",
      providerId: "prov-a",
      externalTransactionId: "ext-rb-2",
      idempotencyKey: "prov-a:ext-rb-2",
      payloadHash: "hash-rb-2",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Rollback,
      money,
      referenceExternalTransactionId: "ext-win",
    });

    expect(rollbackOfWin.ledgerDirectionFor(winTx)).toBe(LedgerDirection.Debit);
  });
});
