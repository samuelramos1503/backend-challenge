import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InsufficientBalanceError } from "../../src/domain/errors/domain.error";
import { Money } from "../../src/domain/models/money.vo";
import { Wallet } from "../../src/domain/models/wallet.aggregate";
import { LedgerDirection } from "../../src/domain/models/wallet-ledger-entry.entity";

describe("Wallet Aggregate Root", () => {
  it("should open a wallet with initial balance and version 1", () => {
    const initialBalance = Money.from({ amount: "500.00", currency: "BRL" });
    const { wallet } = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance,
    });

    expect(wallet.id).toBe("w-1");
    expect(wallet.playerId).toBe("p-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.amount).toBe("500.00");
    expect(wallet.version).toBe(1);
  });

  it("should debit wallet, increment version, and produce balanced ledger entry", () => {
    const { wallet } = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const debitAmount = Money.from({ amount: "40.00", currency: "BRL" });
    const { newBalance, entry } = wallet.debit(debitAmount, "tx-1", "entry-1");

    expect(newBalance.amount).toBe("60.00");
    expect(wallet.balance.amount).toBe("60.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.amount).toBe("40.00");
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("60.00");
    expect(entry.isBalanced()).toBe(true);
  });

  it("should reject debit if balance is insufficient and not change version", () => {
    const { wallet } = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    const excessDebit = Money.from({ amount: "60.00", currency: "BRL" });
    expect(() => wallet.debit(excessDebit, "tx-1", "entry-1")).toThrow(InsufficientBalanceError);
    expect(wallet.balance.amount).toBe("50.00");
    expect(wallet.version).toBe(1);
  });

  it("should credit wallet, increment version, and produce balanced ledger entry", () => {
    const { wallet } = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const creditAmount = Money.from({ amount: "75.50", currency: "BRL" });
    const { newBalance, entry } = wallet.credit(creditAmount, "tx-2", "entry-2");

    expect(newBalance.amount).toBe("175.50");
    expect(wallet.balance.amount).toBe("175.50");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  it("should prevent debit and credit with different currency", () => {
    const { wallet } = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const usdMoney = Money.from({ amount: "10.00", currency: "USD" });
    expect(() => wallet.debit(usdMoney, "tx-3", "entry-3")).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usdMoney, "tx-4", "entry-4")).toThrow(CurrencyMismatchError);
  });
});
