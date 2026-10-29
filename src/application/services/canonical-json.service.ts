import { createHash } from "node:crypto";

export class CanonicalJsonService {
  /**
   * Recursively sorts object keys lexicographically and produces a deterministic JSON string.
   */
  public static stringify(obj: unknown): string {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
      return "[" + obj.map((item) => CanonicalJsonService.stringify(item)).join(",") + "]";
    }

    const record = obj as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const entries = sortedKeys
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${CanonicalJsonService.stringify(record[key])}`);

    return "{" + entries.join(",") + "}";
  }

  /**
   * Hashes a canonical JSON representation using SHA-256.
   */
  public static hash(obj: unknown): string {
    const canonicalString = CanonicalJsonService.stringify(obj);
    return createHash("sha256").update(canonicalString, "utf8").digest("hex");
  }

  /**
   * Extracts the canonical business payload subset from a transaction request for idempotency hashing.
   */
  public static extractBusinessPayload(input: {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  }): Record<string, unknown> {
    return {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: {
        amount: input.money.amount,
        currency: input.money.currency,
      },
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    };
  }
}
