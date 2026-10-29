# Jungle Gaming Technical Challenge — Distributed Wagering Processor

> **Status do Projeto e Ponto de Parada (Handoff)**  
> Atualizado em: 29/10/2026 às 17:55 (Horário de Brasília)

---

## 1. Contexto e Objetivo
- **Candidato:** Samuel Ramos Dionisio (`samuelramos1503`)
- **Vaga:** Backend Developer Júnior — Jungle Gaming (empresa de software house para iGaming/cassino online).
- **Repositório Oficial do Desafio:** `https://github.com/junglegaming/backend-challenge.git`
- **Repositório de Trabalho do Samuel:** `https://github.com/samuelramos1503/backend-challenge.git`
- **Objetivo Central:** Construir um processador distribuído de apostas com precisão financeira estrita, concorrência segura entre múltiplas instâncias, idempotência persistente, ledger imutável (livro-razão), mensageria com AWS SQS (LocalStack) e Transactional Outbox.

---

## 2. As 9 Regras Invioláveis do Desafio (Critérios Eliminatórios)
1. **Nunca usar `number`, `float` ou `double` para dinheiro** — sempre usar o Value Object `Money` com escala fixa de 2 casas decimais (`Decimal.js`).
2. **Nunca usar cache em memória para idempotência** — a garantia é persistida no banco de dados por chave de idempotência e hash do payload canônico.
3. **Não confiar apenas em SQS FIFO** — o PostgreSQL é a fonte da verdade para consistência e invariantes.
4. **Nunca publicar eventos antes do commit no banco** — padrão **Transactional Outbox**.
5. **Nunca sobrescrever nem deletar registros do ledger** — o ledger é *append-only* (protegido inclusive por triggers no PostgreSQL).
6. **Não usar lock global compartilhado por todas as carteiras** — a concorrência é serializada por carteira individual (`SELECT ... FOR UPDATE` no `walletId`).
7. **Não implementar saldo como `read -> calculate -> update` sem controle de concorrência**.
8. **A solução deve funcionar corretamente com múltiplas instâncias simultâneas**.
9. **Todas as restrições devem estar no banco (DDL/PostgreSQL)**: `CHECK (balance >= 0)`, unicidade de player+currency, unicidade de idempotency_key e triggers de imutabilidade.

---

## 3. O que já foi implementado e commitado (100% Funcional e Testado)
1. **Ambiente e Ferramentas:**
   - Runtime: **Bun 1.4.4**
   - Framework: **NestJS 10.x**
   - ORM: **MikroORM 6.x** com driver PostgreSQL e Migrator
   - Validações: `decimal.js`, `class-validator`, `class-transformer`
   - Configuração do TypeScript em modo estrito (`strict: true`).

2. **Camada de Domínio (`src/domain/`):**
   - Objeto de Valor `Money`: operações aritméticas exatas, proteção contra moedas diferentes, regex para 2 casas decimais.
   - Entidade/Agregado `Wallet`: controle de saldo, incremento estrito de versão apenas quando o saldo muda, `debit`, `credit` e garantia de saldo não negativo.
   - Entidade `WagerTransaction`: máquina de estados (`PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`), estados terminais imutáveis, validação de referências para `REFUND` e `ROLLBACK`, derivação de direção no ledger.
   - Entidade `WalletLedgerEntry`: registro imutável com validação `isBalanced()` (`balanceBefore ± amount === balanceAfter`).
   - Entidades de Mensageria `InboxMessage` e `OutboxMessage`: controle de tentativas, backoff exponencial e suporte a retry.
   - Eventos de Integração: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`.
   - Códigos de Falha (`FailureCode` enum): taxonomia estável para erros de negócio.

3. **Serviços de Aplicação:**
   - `CanonicalJsonService`: ordenação lexicográfica recursiva de chaves JSON e hash SHA-256 para idempotência sem sofrer com ordem de campos.

4. **Banco de Dados e Infraestrutura (`src/infrastructure/database/`):**
   - Entidades MikroORM (`WalletOrmEntity`, `WalletLedgerEntryOrmEntity`, `WagerTransactionOrmEntity`, `InboxMessageOrmEntity`, `OutboxMessageOrmEntity`).
   - `Migration20261029000001_initial_schema.ts`: DDL completo com `CHECK (balance >= 0)`, constraints `UNIQUE` e triggers `prevent_ledger_mutation` no PostgreSQL.
   - Repositórios MikroORM com lock pessimista (`PESSIMISTIC_WRITE`), paginação por cursor estável (Base64) e agregação para reconciliação.

5. **Testes de Unidade:**
   - 17 testes de unidade implementados (`test/unit/money.vo.spec.ts`, `test/unit/wallet.aggregate.spec.ts`, `test/unit/wager-transaction.entity.spec.ts`, `test/unit/canonical-json.service.spec.ts`).
   - **Resultado:** 17 pass, 0 fail (tempo de execução: ~20-40ms no Bun).

---

## 4. Próximos Passos Imediatos ao Retomar em Casa
1. **Casos de Uso da Aplicação (`src/application/use-cases/`):**
   - Finalizar `ProcessWagerTransactionUseCase` (o motor central que atende tanto HTTP quanto SQS).
   - Finalizar `CreateWalletUseCase` (criação de carteira com saldo inicial via transação interna `OPENING` e crédito no ledger).
   - Finalizar `ReconcileWalletUseCase` (reconciliação do saldo contra o histórico do ledger).
   - Consultas: `GetWalletUseCase`, `GetLedgerEntriesUseCase` (com cursor), `GetWagerTransactionUseCase`.
2. **Camada de Apresentação HTTP (`src/presentation/http/`):**
   - Controllers NestJS (`WalletController`, `WageringController`, `HealthController`).
   - Filtro de exceção para mapeamento de status HTTP limpo (400, 404, 409, 422, etc.).
   - `AuthGuard` no-op (decisão documentada de IdP externo conforme seção 2).
3. **Mensageria SQS & Workers (`src/infrastructure/`):**
   - Worker de Outbox (`OutboxWorker` com `SKIP LOCKED`).
   - Consumidor SQS reutilizando `ProcessWagerTransactionUseCase`.
   - Worker de reprocessamento para `PENDING_REFERENCE`.
4. **Infraestrutura Docker & Testes de Integração:**
   - `docker-compose.yml` (PostgreSQL + LocalStack para SQS).
   - Teste de concorrência com 50 requisições simultâneas e corrida de saldo.
5. **Documentação Final:**
   - `ARCHITECTURE.md` (defesa das decisões técnicas para a entrevista).
