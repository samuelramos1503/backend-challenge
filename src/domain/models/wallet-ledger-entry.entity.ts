import { UnbalancedLedgerEntryError } from "../errors/domain.error";
import { Money, MoneyProps } from "./money.vo";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    if (!this.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `Ledger entry is not balanced: balanceBefore (${balanceBefore}) with direction ${direction} and money (${money}) does not equal balanceAfter (${balanceAfter}).`
      );
    }
  }

  public static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
    );
  }

  public static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      state.createdAt,
    );
  }

  public isBalanced(): boolean {
    if (this.direction === LedgerDirection.Credit) {
      return this.balanceBefore.add(this.money).equals(this.balanceAfter);
    } else {
      return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
    }
  }
}
