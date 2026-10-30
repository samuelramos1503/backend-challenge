# Jungle Gaming Technical Challenge — Distributed Wagering Processor

> **Status do Projeto:** ✅ **100% Concluído, Compilado (`strict: true`) e Pronto para Execução**  
> **Atualizado em:** 30/10/2026 às 08:40 (Horário de Brasília)

---

## 1. Resumo do que está entregue no repositório

1. **Camada de Domínio (`src/domain/`):**
   - `Money` Value Object (`Decimal.js`, escala fixa de 2 casas decimais, rejeição de valores negativos/inválidos na entrada, zero `number`/`float`).
   - `Wallet` Aggregate Root (`open`, `rehydrate`, `debit`, `credit`, controle de `version` incrementado somente quando o saldo muda).
   - `WagerTransaction` Entity (máquina de estados `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`, proteção de estados terminais, `observedBalance` para replays fiéis ao momento da execução, controle de tentativas e backoff exponencial para `PENDING_REFERENCE`).
   - `WalletLedgerEntry` Entity (imutável, validação aritmética `isBalanced()`).
   - `InboxMessage` e `OutboxMessage` Entities.
   - Eventos de Integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`).
   - `FailureCode` enum e hierarquia `DomainError`.

2. **Camada de Aplicação (`src/application/`):**
   - `CanonicalJsonService`: ordenação lexicográfica recursiva de chaves e hash SHA-256.
   - `CreateWalletUseCase`: abertura de carteira + transação interna `OPENING` + lançamento `CREDIT` no ledger + eventos na Outbox na mesma transação SQL.
   - `ProcessWagerTransactionUseCase`: motor transacional unificado (HTTP + SQS + reprocessamento de `PENDING_REFERENCE`), com lock pessimista por carteira (`SELECT ... FOR UPDATE`), idempotência persistente (*double-checked* pré e pós-lock + fallback `23505`), validação completa de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` (incluindo `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` e `ALREADY_REVERSED`).
   - `ReconcileWalletUseCase`: conciliação contábil do saldo armazenado contra a soma do livro-razão, sem sobrescrever divergências silenciosamente, gerando logs estruturados e métricas.
   - `GetWalletUseCase`, `GetLedgerEntriesUseCase` (paginação por cursor opaco Base64URL) e `GetWagerTransactionUseCase`.

3. **Camada de Infraestrutura (`src/infrastructure/`):**
   - Entidades e Repositórios MikroORM PostgreSQL (`src/infrastructure/database/`).
   - `Migration20261029000001_initial_schema.ts`: DDL completo com `CHECK (balance >= 0)`, `chk_ledger_balanced`, `UNIQUE` constraints, índice parcial `uq_wager_tx_single_processed_reversal` e *triggers* PL/pgSQL `prevent_ledger_mutation` e `prevent_terminal_wager_tx_mutation`.
   - `SqsService`, `SqsWagerConsumerWorker` (deduplicação via Inbox, ACK somente após commit, retry com backoff exponencial via VisibilityTimeout, encaminhamento para DLQ e graceful shutdown), `OutboxWorker` (`FOR UPDATE SKIP LOCKED`) e `PendingReferenceWorker`.
   - Observabilidade: `StructuredLoggerService` (JSON estruturado com redaction de payloads financeiros) e `MetricsService` (`GET /metrics` com contadores por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e percentis `p50`/`p95`/`p99`).

4. **Camada de Apresentação HTTP (`src/presentation/http/`):**
   - `WalletController`, `WageringController` e `HealthController` (`/health/live`, `/health/ready`, `/metrics`).
   - `GlobalExceptionFilter` com mapeamento determinístico de status HTTP (`200`, `201`, `202`, `400`, `404`, `409`, `422`, `503`).
   - `ExternalIdpAuthGuard` e `ProviderIdentityPort` documentados conforme Seção 2.

5. **Infraestrutura Docker, Testes e Documentação:**
   - `docker-compose.yml` (PostgreSQL 16 + LocalStack 3.7 com script `scripts/localstack-init.sh`), `Dockerfile` e `.env.example`.
   - Suítes de teste completas:
     - `test/unit/` (23 testes passando em ~35ms)
     - `test/integration/wagering-integration.spec.ts`
     - `test/concurrency/wagering-concurrency.spec.ts` (todos os 8 cenários obrigatórios, incluindo 50x em paralelo, 100 vs 2x80 BRL e cluster com 3 instâncias)
     - `test/load/wagering-load.spec.ts` (`bun run test:load`)
   - `ARCHITECTURE.md` completo com diagramas Mermaid, justificativas, trade-offs e evolução para produção.
