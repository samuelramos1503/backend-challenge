import { Migration } from "@mikro-orm/migrations";

export class Migration20261029000001_initial_schema extends Migration {
  async up(): Promise<void> {
    // 1. Wallets table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY,
        player_id VARCHAR(100) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(18, 2) NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0)
      );
    `);

    // 2. Wallet Ledger Entries table (append-only)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL,
        direction VARCHAR(10) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(18, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after NUMERIC(18, 2) NOT NULL CHECK (balance_after >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT chk_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    // Trigger to guarantee append-only immutability for ledger entries at the database engine level
    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Wallet ledger entries are append-only and cannot be modified or deleted.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON wallet_ledger_entries;
      CREATE TRIGGER trg_prevent_ledger_update
      BEFORE UPDATE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

      DROP TRIGGER IF EXISTS trg_prevent_ledger_delete ON wallet_ledger_entries;
      CREATE TRIGGER trg_prevent_ledger_delete
      BEFORE DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
    `);

    // 3. Wager Transactions table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(150) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        player_id VARCHAR(100) NOT NULL,
        round_id VARCHAR(100) NOT NULL,
        game_id VARCHAR(100) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL CHECK (amount >= 0),
        currency VARCHAR(3) NOT NULL,
        status VARCHAR(30) NOT NULL,
        reference_external_transaction_id VARCHAR(150),
        reference_transaction_id UUID REFERENCES wager_transactions(id),
        failure_code VARCHAR(50),
        observed_balance NUMERIC(18, 2) CHECK (observed_balance IS NULL OR observed_balance >= 0),
        retry_attempts INT NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_wager_tx_wallet ON wager_transactions (wallet_id);
      CREATE INDEX IF NOT EXISTS idx_wager_tx_status ON wager_transactions (status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_wager_tx_provider_external ON wager_transactions (provider_id, external_transaction_id);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_wager_tx_single_processed_reversal
      ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL;

      CREATE OR REPLACE FUNCTION prevent_terminal_wager_tx_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Wager transactions are audit records and cannot be deleted.';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') AND NEW.status <> OLD.status THEN
          RAISE EXCEPTION 'Cannot transition wager transaction % from terminal status % to %.', OLD.id, OLD.status, NEW.status;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_terminal_wager_tx_update ON wager_transactions;
      CREATE TRIGGER trg_prevent_terminal_wager_tx_update
      BEFORE UPDATE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION prevent_terminal_wager_tx_mutation();

      DROP TRIGGER IF EXISTS trg_prevent_wager_tx_delete ON wager_transactions;
      CREATE TRIGGER trg_prevent_wager_tx_delete
      BEFORE DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION prevent_terminal_wager_tx_mutation();
    `);

    // 4. Inbox Messages table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // 5. Outbox Messages table
    this.addSql(`
      CREATE TABLE IF NOT EXISTS outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id VARCHAR(100) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_messages (published_at, next_attempt_at);
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_prevent_wager_tx_delete ON wager_transactions;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_prevent_terminal_wager_tx_update ON wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_terminal_wager_tx_mutation;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_prevent_ledger_delete ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_ledger_mutation;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
