import { FailureCode } from "../models/failure-code.enum";

export abstract class DomainError extends Error {
  abstract readonly code: FailureCode;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = FailureCode.INVALID_AMOUNT_FORMAT;
  constructor(message = "Invalid amount format. Must be a decimal string with exactly 2 decimal places.") {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CURRENCY_MISMATCH;
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientBalanceError extends DomainError {
  readonly code = FailureCode.INSUFFICIENT_FUNDS;
  constructor(message = "Insufficient balance for this operation.") {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = FailureCode.INTERNAL_ERROR;
  constructor(message = "Transaction is in a terminal state or transition is invalid.") {
    super(message);
  }
}

export class InvalidReferenceError extends DomainError {
  readonly code = FailureCode.INVALID_REFERENCE;
  constructor(message: string) {
    super(message);
  }
}

export class DuplicateReversalError extends DomainError {
  readonly code = FailureCode.ALREADY_REVERSED;
  constructor(message = "Transaction has already been reversed by another operation.") {
    super(message);
  }
}

export class ReversalBalanceError extends DomainError {
  readonly code = FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE;
  constructor(message = "Reversal rejected because it would cause a negative balance.") {
    super(message);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = FailureCode.IDEMPOTENCY_PAYLOAD_MISMATCH;
  constructor(message = "Idempotency key was previously used with a different payload.") {
    super(message);
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = FailureCode.WALLET_NOT_FOUND;
  constructor(walletId: string) {
    super(`Wallet with ID '${walletId}' not found.`);
  }
}

export class DuplicateWalletError extends DomainError {
  readonly code = FailureCode.WALLET_ALREADY_EXISTS;
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player '${playerId}' and currency '${currency}'.`);
  }
}

export class TransactionNotFoundError extends DomainError {
  readonly code = FailureCode.TRANSACTION_NOT_FOUND;
  constructor(identifier: string) {
    super(`Wager transaction '${identifier}' not found.`);
  }
}

export class InvalidTransactionKindError extends DomainError {
  readonly code = FailureCode.INVALID_TRANSACTION_KIND;
  constructor(kind: string) {
    super(`Transaction kind '${kind}' is not allowed or invalid.`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = FailureCode.INTERNAL_ERROR;
  constructor(message = "Ledger entry arithmetic is unbalanced (balanceBefore +/- amount !== balanceAfter).") {
    super(message);
  }
}
