import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { CreateWalletUseCase } from "./application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import {
  GetLedgerEntriesUseCase,
  GetWagerTransactionUseCase,
  GetWalletUseCase,
} from "./application/use-cases/wallet-queries.use-case";
import mikroOrmConfig from "./infrastructure/database/mikro-orm.config";
import { OutboxWorker } from "./infrastructure/messaging/outbox.worker";
import { PendingReferenceWorker } from "./infrastructure/messaging/pending-reference.worker";
import { SqsWagerConsumerWorker } from "./infrastructure/messaging/sqs-wager-consumer.worker";
import { SqsService } from "./infrastructure/messaging/sqs.service";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "./infrastructure/observability/structured-logger.service";
import { HealthController } from "./presentation/http/controllers/health.controller";
import { WageringController } from "./presentation/http/controllers/wagering.controller";
import { WalletController } from "./presentation/http/controllers/wallet.controller";
import { GlobalExceptionFilter } from "./presentation/http/filters/domain-exception.filter";
import { ExternalIdpAuthGuard } from "./presentation/http/guards/auth.guard";

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [WalletController, WageringController, HealthController],
  providers: [
    StructuredLoggerService,
    MetricsService,
    SqsService,
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    GetWalletUseCase,
    GetLedgerEntriesUseCase,
    GetWagerTransactionUseCase,
    OutboxWorker,
    PendingReferenceWorker,
    SqsWagerConsumerWorker,
    {
      provide: APP_GUARD,
      useClass: ExternalIdpAuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
