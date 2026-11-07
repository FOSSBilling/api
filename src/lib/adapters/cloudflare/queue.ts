import type { IMessageQueue } from "../../interfaces";

export class CloudflareQueueAdapter implements IMessageQueue {
  constructor(private readonly queue: Queue) {}

  async send(body: unknown): Promise<void> {
    await this.queue.send(body, { contentType: "json" });
  }
}
