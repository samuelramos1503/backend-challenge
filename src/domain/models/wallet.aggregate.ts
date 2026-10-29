import { CurrencyMismatchError, InsufficientBalanceError } from "../errors/domain.error";
import { Money, MoneyProps } from "./money.vo";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.entity";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  public static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt?: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const createdAt = props.createdAt ?? new Date();
    const currency = props.initialBalance.currency;

    // A wallet starts with version 1
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      createdAt,
      createdAt,
    );

    return { wallet };
  }

  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  public get balance(): Money {
    return this._balance;
  }

  public get version(): number {
    return this._version;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public debit(
    money: Money,
    transactionId: string,
    entryId: string,
    at: Date = new Date(),
  ): { newBalance: Money; entry: WalletLedgerEntry } {
    this.assertSameCurrency(money);

    if (this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError(
        `Cannot debit ${money.amount} ${money.currency}: current balance is ${this._balance.amount} ${this._balance.currency}.`
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(money);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Debit,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });

    return { newBalance: balanceAfter, entry };
  }

  public credit(
    money: Money,
    transactionId: string,
    entryId: string,
    at: Date = new Date(),
  ): { newBalance: Money; entry: WalletLedgerEntry } {
    this.assertSameCurrency(money);

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(money);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });

    return { newBalance: balanceAfter, entry };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
