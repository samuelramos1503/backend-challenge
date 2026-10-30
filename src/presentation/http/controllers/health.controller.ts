import { EntityManager } from "@mikro-orm/postgresql";
import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import { Response } from "express";
import { SqsService } from "../../../infrastructure/messaging/sqs.service";
import { MetricsService } from "../../../infrastructure/observability/metrics.service";
import { Public } from "../guards/auth.guard";

@Controller()
export class HealthController {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsService) private readonly sqsService: SqsService,
    @Inject(MetricsService) private readonly metricsService: MetricsService,
  ) {}

  @Public()
  @Get("health/live")
  public live() {
    return {
      status: "ok",
      check: "liveness",
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get("health/ready")
  public async ready(@Res({ passthrough: true }) res: Response) {
    let postgresUp = false;
    try {
      await this.em.getConnection().execute("SELECT 1");
      postgresUp = true;
    } catch {
      postgresUp = false;
    }

    const sqsUp = await this.sqsService.checkHealth();
    const isReady = postgresUp && sqsUp;

    res.status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: isReady ? "ready" : "degraded",
      check: "readiness",
      dependencies: {
        postgresql: postgresUp ? "up" : "down",
        sqs: sqsUp ? "up" : "down",
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get("metrics")
  public metrics() {
    return this.metricsService.getSnapshot();
  }
}
