import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { WalletNotFoundError } from "../../domain/errors/domain.error";
import { MoneyProps } from "../../domain/models/money.vo";
import { MikroOrmWalletLedgerRepository } from "../../infrastructure/database/repositories/mikro-orm-wallet-ledger.repository";
import { MikroOrmWalletRepository } from "../../infrastructure/database/repositories/mikro-orm-wallet.repository";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public async execute(walletId: string, correlationId: string = uuidv7()): Promise<ReconcileWalletResult> {
    if (!UUID_REGEX.test(walletId)) {
      throw new WalletNotFoundError(walletId);
    }

    return this.em.transactional(async (txEm) => {
      const walletRepo = new MikroOrmWalletRepository(txEm);
      const ledgerRepo = new MikroOrmWalletLedgerRepository(txEm);

      const wallet = await walletRepo.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const summary = await ledgerRepo.reconcileWallet(wallet.id, wallet.currency);
      const storedBalance = wallet.balance;
      const calculatedBalance = summary.calculatedBalance;
      const difference = storedBalance.subtract(calculatedBalance);
      const consistent = storedBalance.equals(calculatedBalance);

      if (!consistent) {
        this.metrics.incrementReconciliationDivergences();
        this.logger.error("WALLET_RECONCILIATION_DIVERGENCE", "Divergence detected between wallet balance and ledger", {
          correlationId,
          walletId: wallet.id,
          consistent: false,
          checkedEntries: summary.totalEntries,
          differenceAmount: difference.amount,
          currency: wallet.currency,
        });
      } else {
        this.logger.info("WALLET_RECONCILIATION_OK", "Wallet reconciliation completed consistently", {
          correlationId,
          walletId: wallet.id,
          consistent: true,
          checkedEntries: summary.totalEntries,
        });
      }

      return {
        walletId: wallet.id,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: summary.totalEntries,
      };
    });
  }
}
