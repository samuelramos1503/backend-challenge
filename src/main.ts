import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { StructuredLoggerService } from "./infrastructure/observability/structured-logger.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
  });

  app.enableShutdownHooks();

  const logger = app.get(StructuredLoggerService);

  if (process.env.AUTO_MIGRATE !== "false") {
    const orm = app.get(MikroORM);
    await orm.getMigrator().up();
    logger.info("DATABASE_MIGRATIONS_APPLIED", "Database migrations applied successfully");
  }

  const port = parseInt(process.env.PORT || "3000", 10);
  await app.listen(port, "0.0.0.0");

  logger.info("APPLICATION_STARTED", `Distributed Wagering Processor listening on port ${port}`, {
    port,
  });
}

bootstrap().catch((err) => {
  console.error("Fatal error during application bootstrap:", err);
  process.exit(1);
});
