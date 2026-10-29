import { InboxMessage } from "../models/inbox-message.entity";

export interface IInboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  save(message: InboxMessage): Promise<void>;
}
