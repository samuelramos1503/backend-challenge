import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { StructuredLoggerService } from "../observability/structured-logger.service";

export const WAGER_TRANSACTIONS_QUEUE = "wager-transactions.fifo";
export const WAGER_TRANSACTIONS_DLQ = "wager-transactions-dlq.fifo";
export const WAGERING_EVENTS_QUEUE = "wagering-events.fifo";

@Injectable()
export class SqsService implements OnModuleInit {
  private readonly client: SQSClient;
  private readonly queueUrls = new Map<string, string>();
  private readonly endpoint: string;

  constructor(@Inject(StructuredLoggerService) private readonly logger: StructuredLoggerService) {
    this.endpoint = process.env.AWS_ENDPOINT_URL || process.env.SQS_ENDPOINT || "http://localhost:4566";
    this.client = new SQSClient({
      region: process.env.AWS_REGION || "us-east-1",
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
      },
    });
  }

  public async onModuleInit(): Promise<void> {
    if (process.env.SKIP_SQS_INIT === "true") {
      return;
    }
    try {
      await this.ensureQueuesExist();
    } catch (error) {
      this.logger.warn("SQS_INIT_WARNING", "Could not initialize SQS queues on startup (will retry on demand)", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async ensureQueuesExist(): Promise<void> {
    await this.ensureFifoQueue(WAGER_TRANSACTIONS_DLQ);
    await this.ensureFifoQueue(WAGER_TRANSACTIONS_QUEUE);
    await this.ensureFifoQueue(WAGERING_EVENTS_QUEUE);
  }

  public async ensureFifoQueue(queueName: string): Promise<string> {
    const cached = this.queueUrls.get(queueName);
    if (cached) return cached;

    try {
      const existing = await this.client.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      if (existing.QueueUrl) {
        this.queueUrls.set(queueName, existing.QueueUrl);
        return existing.QueueUrl;
      }
    } catch {
      // Queue does not exist yet; create it below
    }

    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
        },
      }),
    );

    const url = created.QueueUrl!;
    this.queueUrls.set(queueName, url);
    return url;
  }

  public async receiveMessages(
    queueName: string,
    maxMessages = 10,
    waitTimeSeconds = 1,
    visibilityTimeout = 30,
  ): Promise<Message[]> {
    const queueUrl = await this.ensureFifoQueue(queueName);
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeout,
        AttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
      }),
    );
    return res.Messages ?? [];
  }

  public async deleteMessage(queueName: string, receiptHandle: string): Promise<void> {
    const queueUrl = await this.ensureFifoQueue(queueName);
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  public async changeMessageVisibility(
    queueName: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    const queueUrl = await this.ensureFifoQueue(queueName);
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  public async sendFifoMessage(
    queueName: string,
    body: string,
    messageGroupId: string,
    messageDeduplicationId: string,
  ): Promise<string | undefined> {
    const queueUrl = await this.ensureFifoQueue(queueName);
    const res = await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: messageDeduplicationId,
      }),
    );
    return res.MessageId;
  }

  public async checkHealth(): Promise<boolean> {
    try {
      const res = await this.client.send(
        new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_QUEUE }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      return Boolean(res.QueueUrl);
    } catch {
      return false;
    }
  }
}
