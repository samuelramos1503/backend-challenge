import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidAmountError } from "../errors/domain.error";

export interface MoneyProps {
  amount: string;   // decimal string with exactly 2 decimal places, e.g. "25.00"
  currency: string; // ISO-4217, e.g. "BRL"
}

export class Money {
  private static readonly DECIMAL_REGEX = /^\d+\.\d{2}$/;
  private static readonly CURRENCY_REGEX = /^[A-Z]{3}$/;
  private static readonly MAX_AMOUNT = new Decimal("9999999999999999.99");
  private static readonly SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(
    Intl.supportedValuesOf("currency").filter((code) => code !== "XXX" && code !== "XTS"),
  );

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  public static from(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  /**
   * Parses a Money value without enforcing the single-column NUMERIC(18,2) ceiling.
   * Used exclusively for historical ledger sum aggregations during reconciliation.
   */
  public static fromUnbounded(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  private static parse(props: MoneyProps, enforceMaxCeiling: boolean): Money {
    if (!props || typeof props.amount !== "string" || typeof props.currency !== "string") {
      throw new InvalidAmountError("Amount and currency must be non-empty strings.");
    }

    const trimmedAmount = props.amount.trim();
    const trimmedCurrency = props.currency.trim().toUpperCase();

    if (
      !Money.CURRENCY_REGEX.test(trimmedCurrency) ||
      !Money.SUPPORTED_CURRENCIES.has(trimmedCurrency)
    ) {
      throw new InvalidAmountError(`Invalid or unsupported ISO-4217 currency code: '${props.currency}'`);
    }

    const regex = enforceMaxCeiling ? Money.DECIMAL_REGEX : /^-?\d+\.\d{2}$/;
    if (!regex.test(trimmedAmount)) {
      throw new InvalidAmountError(`Amount must have exactly 2 decimal places, received '${props.amount}'`);
    }

    let parsed: Decimal;
    try {
      parsed = new Decimal(trimmedAmount);
    } catch {
      throw new InvalidAmountError(`Unable to parse amount '${props.amount}'`);
    }

    if (!parsed.isFinite()) {
      throw new InvalidAmountError(`Amount must be a finite number, received '${props.amount}'`);
    }

    if (enforceMaxCeiling && parsed.greaterThan(Money.MAX_AMOUNT)) {
      throw new InvalidAmountError(
        `Amount exceeds maximum supported precision NUMERIC(18,2), received '${props.amount}'`,
      );
    }

    return new Money(parsed, trimmedCurrency);
  }

  public static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  public get amount(): string {
    return this.value.toFixed(2);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    const sum = this.value.plus(other.value);
    if (sum.greaterThan(Money.MAX_AMOUNT)) {
      throw new InvalidAmountError("Resulting amount exceeds maximum supported precision NUMERIC(18,2).");
    }
    return new Money(sum, this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  public negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  public isNegative(): boolean {
    return this.value.isNegative();
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  public isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  public isLessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThanOrEqualTo(other.value);
  }

  public isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThanOrEqualTo(other.value);
  }

  public equals(other: Money): boolean {
    if (this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.amount,
      currency: this.currency,
    };
  }

  public toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
