import { Migration } from "@mikro-orm/migrations";

export class Migration20261030000002_add_observed_balance_currency extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN IF NOT EXISTS observed_balance_currency VARCHAR(3);

      UPDATE wager_transactions wt
      SET observed_balance_currency = w.currency
      FROM wallets w
      WHERE wt.wallet_id = w.id
        AND wt.observed_balance IS NOT NULL
        AND wt.observed_balance_currency IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      DROP COLUMN IF EXISTS observed_balance_currency;
    `);
  }
}
