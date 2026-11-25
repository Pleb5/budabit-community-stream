import { describe, expect, it } from "vitest";
import { buildCommunityNsiteUrl, pubkeyToBase36 } from "./nsite";

const BUDABIT_OWNER =
  "0a8ecba4868c13e1e84cc5cb58c02c1fd0880d9e5a25a5050ee96ad8a166d7c8";

describe("community nsite URL builder", () => {
  it("encodes 64-hex pubkey to 50-char base36 and builds canonical NIP-5A stream URL", () => {
    expect(pubkeyToBase36(BUDABIT_OWNER)).toBe(
      "09h14xrgpe560i6z2325fqp4f2i337l13kxrvka7he8wsrqkzs",
    );
    expect(buildCommunityNsiteUrl(BUDABIT_OWNER, "stream")).toBe(
      "https://09h14xrgpe560i6z2325fqp4f2i337l13kxrvka7he8wsrqkzsstream.nsite.run/",
    );
  });

  it("returns empty string for invalid pubkeys", () => {
    expect(buildCommunityNsiteUrl("", "stream")).toBe("");
    expect(buildCommunityNsiteUrl("invalid", "stream")).toBe("");
  });
});
