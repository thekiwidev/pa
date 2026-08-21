// Pure. The recipient-containment check — the defence against a hallucinated
// or injected address (adversarial #9). A draft's recipients must be a
// subset of the source thread's OWN address set (From/To/Cc/Reply-To) as
// Gmail's headers reported it — never the model's opinion, and never
// anything read out of the email body, which is untrusted content (I-2).

/** `"Ada Lovelace" <ada@example.com>` or a bare address — the bare, lowercase
 *  address is always what gets compared. */
function bareAddress(raw: string): string {
  const angled = /<([^>]+)>/.exec(raw);
  return (angled ? angled[1]! : raw).trim().toLowerCase();
}

export interface ThreadAddresses {
  from: string;
  to: string[];
  cc: string[];
  replyTo?: string;
}

/** Every address a reply may land on without extra confirmation. */
export function threadAddressSet(thread: ThreadAddresses): Set<string> {
  const all = [thread.from, ...thread.to, ...thread.cc, thread.replyTo].filter(
    (x): x is string => Boolean(x),
  );
  return new Set(all.map(bareAddress));
}

/**
 * True only if EVERY recipient of the draft already appears somewhere in the
 * source thread's own address set. One address outside that set fails the
 * whole check — there is no partial send.
 */
export function recipientsContained(recipients: string[], thread: ThreadAddresses): boolean {
  const known = threadAddressSet(thread);
  return recipients.every((r) => known.has(bareAddress(r)));
}
