import { describe, expect, test } from "bun:test";
import {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  assertFetchable,
  isAllowedHost,
} from "../../convex/lib/net/urlGuard";

const ok = (url: string) => expect(() => assertFetchable(url)).not.toThrow();
const rejected = (url: string) => expect(() => assertFetchable(url)).toThrow();

describe("assertFetchable — allowed", () => {
  test.each([
    "https://www.instagram.com/p/Cabc123/",
    "https://instagram.com/reel/Cabc123/",
    "https://www.tiktok.com/@user/video/123",
    "https://vm.tiktok.com/ZMabc/",
    "https://x.com/user/status/123",
    "https://twitter.com/user/status/123",
    "https://www.linkedin.com/posts/someone_abc-activity-123",
    "https://www.facebook.com/user/posts/123",
    "https://publish.twitter.com/oembed?url=x",
  ])("%s", (url) => ok(url));
});

describe("assertFetchable — SSRF", () => {
  test.each([
    ["cloud metadata by IP", "http://169.254.169.254/latest/meta-data/"],
    ["cloud metadata over https", "https://169.254.169.254/"],
    ["loopback", "http://127.0.0.1:8080/admin"],
    ["loopback by name", "http://localhost:3000/"],
    ["ipv6 loopback", "http://[::1]/"],
    ["private 10.x", "https://10.0.0.5/"],
    ["private 192.168.x", "https://192.168.1.1/"],
    ["private 172.16.x", "https://172.16.0.1/"],
    ["mdns", "http://printer.local/"],
    ["internal tld", "https://api.internal/"],
    ["a convex deployment", "https://coordinated-owl-164.convex.cloud/"],
    ["an arbitrary host", "https://evil.example.com/collect"],
    ["file scheme", "file:///etc/passwd"],
    ["gopher scheme", "gopher://x.com/"],
    ["data scheme", "data:text/html,<script>"],
    ["javascript scheme", "javascript:alert(1)"],
    ["not a url at all", "just some words"],
  ])("rejects %s", (_label, url) => rejected(url));

  test("rejects plain http even on an allowed host", () => {
    // Downgrade to http would expose the request to a network attacker and
    // every one of these platforms serves https.
    rejected("http://www.instagram.com/p/Cabc123/");
  });

  test("rejects a lookalike domain", () => {
    // "instagram.com.evil.net" ends with nothing we allow, but a naive
    // endsWith on "instagram.com" would let it through.
    rejected("https://instagram.com.evil.net/p/x/");
    rejected("https://notinstagram.com/p/x/");
    rejected("https://evilinstagram.com/p/x/");
  });

  test("rejects userinfo, which can disguise the real host", () => {
    // "https://www.instagram.com@evil.example.com/" fetches evil.example.com.
    rejected("https://www.instagram.com@evil.example.com/");
  });

  test("a subdomain of an allowed host is allowed", () => {
    ok("https://vm.tiktok.com/ZMabc/");
    expect(isAllowedHost("m.facebook.com")).toBe(true);
  });

  test("the returned URL is parsed, so the caller cannot re-introduce the raw string", () => {
    const url = assertFetchable("https://x.com/user/status/123?utm_source=a");
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("x.com");
  });
});

describe("limits", () => {
  test("redirects are capped", () => {
    expect(MAX_REDIRECTS).toBeLessThanOrEqual(3);
  });

  test("response size is capped well under the action memory budget", () => {
    expect(MAX_RESPONSE_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
