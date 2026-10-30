import "reflect-metadata";
import { PurgeQueueCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { OutboxWorker } from "../../src/infrastructure/messaging/outbox.worker";
import { PendingReferenceWorker } from "../../src/infrastructure/messaging/pending-reference.worker";
import { SqsWagerConsumerWorker } from "../../src/infrastructure/messaging/sqs-wager-consumer.worker";
import {
  SqsService,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
  WAGERING_EVENTS_QUEUE,
} from "../../src/infrastructure/messaging/sqs.service";

export interface TestAppInstance {
  app: INestApplication;
  baseUrl: string;
  orm: MikroORM;
  em: EntityManager;
  sqsService: SqsService;
  sqsConsumer: SqsWagerConsumerWorker;
  outboxWorker: OutboxWorker;
  pendingRefWorker: PendingReferenceWorker;
  reconcileUseCase: ReconcileWalletUseCase;
}

export async function createTestAppInstance(port = 0): Promise<TestAppInstance> {
  process.env.DISABLE_BACKGROUND_WORKERS = "true";
  process.env.LOG_SILENT = process.env.LOG_SILENT ?? "true";

  const app = await NestFactory.create(AppModule, {
    logger: false,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  const orm = app.get(MikroORM);
  await orm.getMigrator().up();

  const sqsService = app.get(SqsService);
  await sqsService.ensureQueuesExist();

  await app.listen(port, "127.0.0.1");
  const server = app.getHttpServer();
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    app,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    orm,
    em: app.get(EntityManager),
    sqsService,
    sqsConsumer: app.get(SqsWagerConsumerWorker),
    outboxWorker: app.get(OutboxWorker),
    pendingRefWorker: app.get(PendingReferenceWorker),
    reconcileUseCase: app.get(ReconcileWalletUseCase),
  };
}

export async function resetDatabaseAndQueues(instance: TestAppInstance): Promise<void> {
  const conn = instance.em.getConnection();
  await conn.execute(`
    ALTER TABLE wallet_ledger_entries DISABLE TRIGGER USER;
    ALTER TABLE wager_transactions DISABLE TRIGGER USER;
    TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE;
    ALTER TABLE wallet_ledger_entries ENABLE TRIGGER USER;
    ALTER TABLE wager_transactions ENABLE TRIGGER USER;
  `);

  for (const queueName of [
    WAGER_TRANSACTIONS_QUEUE,
    WAGER_TRANSACTIONS_DLQ,
    WAGERING_EVENTS_QUEUE,
  ]) {
    try {
      const queueUrl = await instance.sqsService.ensureFifoQueue(queueName);
      // Drain any leftover messages in LocalStack
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (instance.sqsService as any).client;
      await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    } catch {
      // Drain via receive/delete if PurgeQueue is throttled
      const msgs = await instance.sqsService.receiveMessages(queueName, 10, 0, 1);
      for (const m of msgs) {
        if (m.ReceiptHandle) {
          await instance.sqsService.deleteMessage(queueName, m.ReceiptHandle);
        }
      }
    }
  }
}

export async function assertWalletLedgerInvariant(
  instance: TestAppInstance,
  walletId: string,
): Promise<void> {
  const report = await instance.reconcileUseCase.execute(walletId);
  if (!report.consistent || report.difference.amount !== "0.00") {
    throw new Error(
      `Wallet ledger invariant violated for wallet ${walletId}: stored=${report.storedBalance.amount}, calculated=${report.calculatedBalance.amount}, diff=${report.difference.amount}`,
    );
  }
}
