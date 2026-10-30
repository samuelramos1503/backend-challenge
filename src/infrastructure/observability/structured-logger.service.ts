import { Injectable } from "@nestjs/common";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  kind?: string;
  status?: string;
  failureCode?: string;
  durationMs?: number;
  [key: string]: unknown;
}

const REDACTED_KEYS = new Set(["money", "amount", "balance", "balanceBefore", "balanceAfter", "initialBalance", "storedBalance", "calculatedBalance"]);

@Injectable()
export class StructuredLoggerService {
  private readonly silent = process.env.LOG_SILENT === "true";

  public info(event: string, message: string, context: LogContext = {}): void {
    this.write("INFO", event, message, context);
  }

  public warn(event: string, message: string, context: LogContext = {}): void {
    this.write("WARN", event, message, context);
  }

  public error(event: string, message: string, context: LogContext = {}): void {
    this.write("ERROR", event, message, context);
  }

  private write(level: "INFO" | "WARN" | "ERROR", event: string, message: string, context: LogContext): void {
    if (this.silent) {
      return;
    }

    const sanitizedContext: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) continue;
      if (REDACTED_KEYS.has(key)) continue;
      sanitizedContext[key] = value;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: "distributed-wagering-processor",
      event,
      message,
      ...sanitizedContext,
    };

    const serialized = JSON.stringify(entry);
    if (level === "ERROR") {
      process.stderr.write(serialized + "\n");
    } else {
      process.stdout.write(serialized + "\n");
    }
  }
}
