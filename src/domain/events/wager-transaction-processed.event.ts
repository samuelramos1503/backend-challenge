import { MoneyProps } from "../models/money.vo";
import { WagerTransaction } from "../models/wager-transaction.entity";
import { EventContext } from "./wallet-balance-changed.event";
import { IntegrationEvent, IntegrationEventProps } from "./integration-event.base";

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  public constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  public static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: transaction.processedAt ?? new Date(),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        status: transaction.status,
        referenceTransactionId: transaction.referenceTransactionId,
      },
    });
  }
}
