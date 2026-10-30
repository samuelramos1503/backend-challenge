import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
} from "@nestjs/common";
import { Response, Request } from "express";
import {
  CurrencyMismatchError,
  DomainError,
  DuplicateReversalError,
  DuplicateWalletError,
  IdempotencyConflictError,
  InsufficientBalanceError,
  InvalidAmountError,
  InvalidReferenceError,
  InvalidTransactionKindError,
  ReversalBalanceError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from "../../../domain/errors/domain.error";
import { FailureCode } from "../../../domain/models/failure-code.enum";
import { StructuredLoggerService } from "../../../infrastructure/observability/structured-logger.service";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(@Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = (request.headers?.["x-correlation-id"] as string) || undefined;

    if (exception instanceof DomainError) {
      const status = this.mapDomainErrorToStatus(exception);
      response.status(status).json({
        statusCode: status,
        failureCode: exception.code,
        error: exception.name,
        message: exception.message,
        timestamp: new Date().toISOString(),
        path: request.url,
      });
      return;
    }

    if (exception instanceof BadRequestException) {
      const resBody = exception.getResponse() as Record<string, unknown> | string;
      const message =
        typeof resBody === "object" && resBody !== null && "message" in resBody
          ? resBody.message
          : exception.message;

      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        failureCode: FailureCode.INVALID_AMOUNT_FORMAT,
        error: "BadRequest",
        message,
        timestamp: new Date().toISOString(),
        path: request.url,
      });
      return;
    }

    if (exception instanceof NotFoundException) {
      response.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        failureCode: FailureCode.WALLET_NOT_FOUND,
        error: "NotFound",
        message: exception.message,
        timestamp: new Date().toISOString(),
        path: request.url,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({
        statusCode: status,
        failureCode: FailureCode.INTERNAL_ERROR,
        error: exception.name,
        message: exception.message,
        timestamp: new Date().toISOString(),
        path: request.url,
      });
      return;
    }

    // Transient database/infrastructure errors map to 503 Service Unavailable
    const isTransientInfra = this.isTransientInfrastructureError(exception);
    const status = isTransientInfra
      ? HttpStatus.SERVICE_UNAVAILABLE
      : HttpStatus.INTERNAL_SERVER_ERROR;

    this.logger.error("UNHANDLED_HTTP_EXCEPTION", "Unhandled exception in HTTP layer", {
      correlationId,
      path: request.url,
      statusCode: status,
      error: exception instanceof Error ? exception.message : String(exception),
    });

    response.status(status).json({
      statusCode: status,
      failureCode: FailureCode.INTERNAL_ERROR,
      error: isTransientInfra ? "ServiceUnavailable" : "InternalServerError",
      message: isTransientInfra
        ? "Temporary infrastructure unavailability. Safe to retry with the same Idempotency-Key."
        : "An unexpected internal error occurred.",
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private mapDomainErrorToStatus(error: DomainError): number {
    if (
      error instanceof InvalidAmountError ||
      error instanceof InvalidTransactionKindError ||
      error instanceof InvalidReferenceError
    ) {
      return HttpStatus.BAD_REQUEST;
    }

    if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
      return HttpStatus.NOT_FOUND;
    }

    if (error instanceof IdempotencyConflictError || error instanceof DuplicateWalletError) {
      return HttpStatus.CONFLICT;
    }

    if (
      error instanceof InsufficientBalanceError ||
      error instanceof CurrencyMismatchError ||
      error instanceof DuplicateReversalError ||
      error instanceof ReversalBalanceError
    ) {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }

    return HttpStatus.UNPROCESSABLE_ENTITY;
  }

  private isTransientInfrastructureError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const err = error as Record<string, unknown>;
    const code = String(err.code ?? "");
    const msg = String(err.message ?? "").toLowerCase();
    return (
      code === "40001" || // serialization_failure
      code === "40P01" || // deadlock_detected
      code === "55P03" || // lock_not_available
      code === "08006" || // connection_failure
      code === "ECONNREFUSED" ||
      msg.includes("connection") ||
      msg.includes("timeout")
    );
  }
}
