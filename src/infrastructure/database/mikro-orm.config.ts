import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { WalletOrmEntity } from "./entities/wallet.orm-entity";
import { WalletLedgerEntryOrmEntity } from "./entities/wallet-ledger-entry.orm-entity";
import { WagerTransactionOrmEntity } from "./entities/wager-transaction.orm-entity";
import { InboxMessageOrmEntity } from "./entities/inbox-message.orm-entity";
import { OutboxMessageOrmEntity } from "./entities/outbox-message.orm-entity";

export default defineConfig({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  dbName: process.env.DB_NAME || "wagering_db",
  entities: [
    WalletOrmEntity,
    WalletLedgerEntryOrmEntity,
    WagerTransactionOrmEntity,
    InboxMessageOrmEntity,
    OutboxMessageOrmEntity,
  ],
  extensions: [Migrator],
  migrations: {
    path: "./src/infrastructure/database/migrations",
    pathTs: "./src/infrastructure/database/migrations",
    glob: "!(*.d).{js,ts}",
    transactional: true,
    allOrNothing: true,
    safe: false,
    dropTables: false,
  },
  debug: process.env.DB_DEBUG === "true",
});
