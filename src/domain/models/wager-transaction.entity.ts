import { InvalidTransactionStateError } from "../errors/domain.error";
import { FailureCode } from "./failure-code.enum";
import { Money, MoneyProps } from "./money.vo";
import { LedgerDirection } from "./wallet-ledger-entry.entity";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: MoneyProps;
  retryAttempts?: number;
  nextRetryAt?: Date;
}

export class WagerTransaction {
  public static readonly MAX_REFERENCE_RETRY_ATTEMPTS = 5;
  private static readonly BASE_RETRY_DELAY_MS = 500;
  private static readonly MAX_RETRY_DELAY_MS = 16000;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _retryAttempts: number = 0,
    private _nextRetryAt?: Date,
  ) {}

  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new Error(`Kind ${props.kind} requires referenceExternalTransactionId.`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance ? Money.from(state.observedBalance) : undefined,
      state.retryAttempts ?? 0,
      state.nextRetryAt,
    );
  }

  public get status(): WagerTransactionStatus {
    return this._status;
  }

  public get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  public get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  public get processedAt(): Date | undefined {
    return this._processedAt;
  }

  public get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  public get retryAttempts(): number {
    return this._retryAttempts;
  }

  public get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }

  public recordObservedBalance(balance: Money): void {
    this._observedBalance = balance;
  }

  public markProcessed(referenceTransactionId: string | undefined, at: Date = new Date(), observedBalance?: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  public markPendingReference(now: Date = new Date(), observedBalance?: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
    if (!this._nextRetryAt) {
      this._nextRetryAt = new Date(now.getTime() + WagerTransaction.BASE_RETRY_DELAY_MS);
    }
  }

  public scheduleReferenceRetry(now: Date = new Date()): void {
    this.assertNotTerminal();
    this._retryAttempts += 1;
    const delay = Math.min(
      WagerTransaction.BASE_RETRY_DELAY_MS * Math.pow(2, this._retryAttempts),
      WagerTransaction.MAX_RETRY_DELAY_MS,
    );
    this._nextRetryAt = new Date(now.getTime() + delay);
  }

  public hasExhaustedReferenceRetries(maxAttempts: number = WagerTransaction.MAX_REFERENCE_RETRY_ATTEMPTS): boolean {
    return this._retryAttempts >= maxAttempts;
  }

  public isDueForRetry(now: Date = new Date()): boolean {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      return false;
    }
    return !this._nextRetryAt || this._nextRetryAt.getTime() <= now.getTime();
  }

  public reject(code: FailureCode, observedBalance?: Money): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date();
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  public fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  public isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  public affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  public requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  public matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  public ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new Error("Cannot determine ledger direction for ROLLBACK without reference transaction.");
        }
        // Rollback reverses the effect of the reference transaction
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        } else if (reference.kind === WagerTransactionKind.Win || reference.kind === WagerTransactionKind.Refund) {
          return LedgerDirection.Debit;
        }
        throw new Error(`Unsupported reference transaction kind for ROLLBACK: ${reference.kind}`);
      }
      default:
        throw new Error(`Transaction kind ${this.kind} does not generate a ledger direction.`);
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition transaction ${this.id} from terminal state ${this._status}.`
      );
    }
  }
}
