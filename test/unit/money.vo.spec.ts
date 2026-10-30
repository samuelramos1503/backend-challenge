import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InvalidAmountError } from "../../src/domain/errors/domain.error";
import { Money } from "../../src/domain/models/money.vo";

describe("Money Value Object", () => {
  it("should create a valid Money instance", () => {
    const money = Money.from({ amount: "100.50", currency: "BRL" });
    expect(money.amount).toBe("100.50");
    expect(money.currency).toBe("BRL");
    expect(money.toString()).toBe("100.50 BRL");
  });

  it("should reject amounts without exactly 2 decimal places", () => {
    expect(() => Money.from({ amount: "100", currency: "BRL" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "100.5", currency: "BRL" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "100.555", currency: "BRL" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "100,50", currency: "BRL" })).toThrow(InvalidAmountError);
  });

  it("should reject invalid inputs like NaN, Infinity, scientific notation, empty strings, and negative inputs", () => {
    expect(() => Money.from({ amount: "NaN", currency: "BRL" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "Infinity", currency: "BRL" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "1e5", currency: "BRL" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "-10.00", currency: "BRL" })).toThrow(InvalidAmountError);
  });

  it("should perform addition and subtraction without floating point errors", () => {
    const m1 = Money.from({ amount: "0.10", currency: "BRL" });
    const m2 = Money.from({ amount: "0.20", currency: "BRL" });
    const sum = m1.add(m2);
    expect(sum.amount).toBe("0.30");

    const diff = sum.subtract(m1);
    expect(diff.amount).toBe("0.20");
  });

  it("should prevent operations between different currencies", () => {
    const brl = Money.from({ amount: "50.00", currency: "BRL" });
    const usd = Money.from({ amount: "50.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });

  it("should correctly compare amounts", () => {
    const m1 = Money.from({ amount: "10.00", currency: "BRL" });
    const m2 = Money.from({ amount: "20.00", currency: "BRL" });
    const m3 = Money.from({ amount: "10.00", currency: "BRL" });

    expect(m1.isLessThan(m2)).toBe(true);
    expect(m2.isGreaterThan(m1)).toBe(true);
    expect(m1.equals(m3)).toBe(true);
    expect(m1.isZero()).toBe(false);
    expect(Money.zero("BRL").isZero()).toBe(true);
  });

  it("should reject unsupported or malformed currency codes and amounts exceeding NUMERIC(18,2)", () => {
    expect(() => Money.from({ amount: "10.00", currency: "ABCD" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "10.00", currency: "QQQ" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "10.00", currency: "XXX" })).toThrow(InvalidAmountError);
    expect(() => Money.from({ amount: "10000000000000000.00", currency: "BRL" })).toThrow(
      InvalidAmountError,
    );

    const max = Money.from({ amount: "9999999999999999.99", currency: "BRL" });
    expect(() => max.add(Money.from({ amount: "0.01", currency: "BRL" }))).toThrow(
      InvalidAmountError,
    );
  });
});
