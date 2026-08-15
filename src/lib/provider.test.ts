import { describe, expect, it } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import {
  getAdvertisedProviderPubkey,
  getProviderPreparationBinding,
  type ProviderAccount,
} from "./provider";

const trustedProvider = "a".repeat(64);
const account = {
  balance: 0,
  endpoints: [],
  details: { id: "account-stream" },
} satisfies ProviderAccount;

describe("provider preparation binding", () => {
  it("prefers stream and trusted provider identity returned by update", () => {
    expect(
      getProviderPreparationBinding(
        account,
        {
          id: "updated-stream",
          provider_pubkey: trustedProvider.toUpperCase(),
        },
        new Set([trustedProvider]),
      ),
    ).toEqual({
      streamIdentifier: "updated-stream",
      providerPubkey: trustedProvider,
    });
  });

  it("falls back to account identity and rejects untrusted provider hints", () => {
    expect(
      getProviderPreparationBinding(
        { ...account, provider_pubkey: "b".repeat(64) },
        {},
        new Set([trustedProvider]),
      ),
    ).toEqual({
      streamIdentifier: "account-stream",
      providerPubkey: undefined,
    });
  });

  it("selects only a trusted advertisement for the exact provider URL", () => {
    const secretKey = new Uint8Array(32).fill(1);
    const pubkey = getPublicKey(secretKey);
    const advertisement = finalizeEvent(
      {
        kind: 31_990,
        created_at: 1_000,
        content: JSON.stringify({ website: "https://provider.example/api/v1/" }),
        tags: [
          ["d", "provider"],
          ["k", "30311"],
        ],
      },
      secretKey,
    );
    expect(
      getAdvertisedProviderPubkey(
        [advertisement],
        "https://provider.example/api/v1",
        new Set([pubkey]),
      ),
    ).toBe(pubkey);
    expect(
      getAdvertisedProviderPubkey(
        [advertisement],
        "https://other.example/api/v1",
        new Set([pubkey]),
      ),
    ).toBeUndefined();
  });
});
