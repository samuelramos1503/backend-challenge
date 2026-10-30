import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { CreateWalletDto } from "../../../application/dtos/create-wallet.dto";
import { CreateWalletUseCase } from "../../../application/use-cases/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../../application/use-cases/reconcile-wallet.use-case";
import {
  GetLedgerEntriesUseCase,
  GetWalletUseCase,
} from "../../../application/use-cases/wallet-queries.use-case";

@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWalletUseCase: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWalletUseCase: GetWalletUseCase,
    @Inject(GetLedgerEntriesUseCase) private readonly getLedgerEntriesUseCase: GetLedgerEntriesUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async createWallet(
    @Body() dto: CreateWalletDto,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.createWalletUseCase.execute({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
      correlationId,
    });
  }

  @Get(":walletId")
  @HttpCode(HttpStatus.OK)
  public async getWallet(@Param("walletId") walletId: string) {
    return this.getWalletUseCase.execute(walletId);
  }

  @Get(":walletId/ledger")
  @HttpCode(HttpStatus.OK)
  public async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.getLedgerEntriesUseCase.execute(
      walletId,
      cursor,
      Number.isNaN(parsedLimit) ? 50 : parsedLimit,
    );
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  public async reconcileWallet(
    @Param("walletId") walletId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.reconcileWalletUseCase.execute(walletId, correlationId);
  }
}
