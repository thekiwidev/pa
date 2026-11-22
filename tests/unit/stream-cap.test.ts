import { describe, expect, test } from "bun:test";
import { readCapped, readCappedText } from "../../convex/lib/net/stream";

function streamOf(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let i = 0;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks.length) controller.close();
        else controller.enqueue(chunks[i++]!);
      },
    }),
    pulled: () => i,
  };
}
const bytes = (n: number, fill = 97) => new Uint8Array(n).fill(fill);

describe("readCapped", () => {
  test("a body under the cap comes back whole", async () => {
    const { stream } = streamOf([bytes(3), bytes(4)]);
    const out = await readCapped(stream, 100);
    expect(out.bytes.length).toBe(7);
    expect(out.truncated).toBe(false);
  });

  test("a body over the cap is cut exactly at the cap", async () => {
    const { stream } = streamOf([bytes(6), bytes(6)]);
    const out = await readCapped(stream, 10);
    expect(out.bytes.length).toBe(10);
    expect(out.truncated).toBe(true);
  });

  test("stops pulling once the cap is passed instead of reading the rest", async () => {
    const { stream, pulled } = streamOf(Array.from({ length: 1000 }, () => bytes(1024)));
    await readCapped(stream, 2048);
    expect(pulled()).toBeLessThan(10);
  });

  test("a null body is empty", async () => {
    expect(await readCapped(null, 10)).toEqual({ bytes: new Uint8Array(0), truncated: false });
  });

  test("text helper decodes utf-8", async () => {
    const { stream } = streamOf([new TextEncoder().encode("héllo")]);
    expect(await readCappedText(stream, 100)).toBe("héllo");
  });
});
