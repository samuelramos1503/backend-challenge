import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { SubmitWagerTransactionDto } from "../../../application/dtos/submit-wager-transaction.dto";
import { ProcessWagerTransactionUseCase } from "../../../application/use-cases/process-wager-transaction.use-case";
import { GetWagerTransactionUseCase } from "../../../application/use-cases/wallet-queries.use-case";
import { WagerTransactionStatus } from "../../../domain/models/wager-transaction.entity";

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase) private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post("wagering/transactions")
  public async submitTransaction(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      throw new BadRequestException("Header 'Idempotency-Key' is required.");
    }

    const result = await this.processWagerTransactionUseCase.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      correlationId,
    });

    if (result.status === WagerTransactionStatus.Processed) {
      res.status(HttpStatus.OK);
    } else if (result.status === WagerTransactionStatus.PendingReference) {
      res.status(HttpStatus.ACCEPTED);
    } else if (result.status === WagerTransactionStatus.Rejected) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return result;
  }

  @Get("wagering/transactions/:transactionId")
  public async getTransactionById(@Param("transactionId") transactionId: string) {
    return this.getWagerTransactionUseCase.executeById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  public async getTransactionByProviderAndExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.getWagerTransactionUseCase.executeByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
