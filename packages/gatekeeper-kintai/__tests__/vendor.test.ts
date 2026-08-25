import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("kintai vendor", () => {
  it("declares itself as an auto-provisioned, non-auth vendor", async () => {
    const description = await env.KINTAI_VENDOR.describe();

    expect(description.autoProvisionsAccount).toBe(true);
    expect(description.providesAuth).toBe(false);
    expect(description.displayName).toBe("Kintai");
  });
});
