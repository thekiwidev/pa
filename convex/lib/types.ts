import type { Id } from "../_generated/dataModel";

export type MessageKind = "text" | "voice" | "document" | "photo";

/**
 * The normalized inbound message. Every channel adapter converts its own
 * payload into this, and nothing downstream knows which channel it came from.
 *
 * Note `receivedAt: number` — Convex has no Date type. Store ms-epoch,
 * format at the edge.
 */
export interface IncomingMessage {
  channel: string;
  channelMessageId: string;
  userId: Id<"users">;
  kind: MessageKind;
  text?: string;
  mediaRef?: { url: string; mimeType: string; sizeBytes: number };
  receivedAt: number;
}
