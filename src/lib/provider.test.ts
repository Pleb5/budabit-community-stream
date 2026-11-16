import { afterEach, describe, expect, it, vi } from "vitest";
import type { WidgetBridge } from "budabit-sdk";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import {
  getAdvertisedProviderPubkey,
  getDefaultProviderAdvertisement,
  getProviderPreparationBinding,
  StreamProviderClient,
  type ProviderAccount,
} from "./provider";

const trustedProvider = "a".repeat(64);
const account = {
  balance: 0,
  endpoints: [],
  details: { id: "account-stream" },
} satisfies ProviderAccount;

describe("provider preparation binding", () => {
  it.each([null, undefined])("allows successful updates without metadata (%s)", (update) => {
    expect(getProviderPreparationBinding(
      { ...account, provider_pubkey: trustedProvider },
      update,
      new Set([trustedProvider]),
    )).toEqual({ streamIdentifier: "account-stream", providerPubkey: trustedProvider });
    expect(getProviderPreparationBinding(
      { balance: 0, endpoints: [], details: null } as unknown as ProviderAccount,
      update,
      new Set([trustedProvider]),
    )).toEqual({ streamIdentifier: undefined, providerPubkey: undefined });
  });
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
          ["i", "api:zap-stream"],
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

describe("stream metadata update responses", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () => new StreamProviderClient({
    request: async (_action: string, template: EventTemplate) => ({
      event: finalizeEvent(template, new Uint8Array(32).fill(4)),
    }),
  } as unknown as WidgetBridge, "https://provider.example/api/v1");

  it.each([
    { body: "null", status: 200 },
    { body: "", status: 200 },
    { body: null, status: 204 },
  ])("prepares successfully after a metadata-only response (%j)", async ({ body, status }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const update = await client().updateStream({ title: "Community call" });
    expect(update).toEqual({});
    expect(getProviderPreparationBinding(account, update, new Set())).toEqual({
      streamIdentifier: "account-stream", providerPubkey: undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/api/v1/event",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ title: "Community call" }) }),
    );
  });

  it("preserves identifiers returned by providers that supply metadata", async () => {
    const response = { id: "prepared-stream", provider_pubkey: trustedProvider };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
    expect(await client().updateStream({ title: "Community call" })).toEqual(response);
  });

  it("does not mistake an unsuccessful update for an empty success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Metadata rejected" }), { status: 400 },
    )));
    await expect(client().updateStream({ title: "Community call" })).rejects.toThrow("Metadata rejected");
  });
});

describe("default provider discovery", () => {
  const secretKey = new Uint8Array(32).fill(2);
  const pubkey = getPublicKey(secretKey);
  const trusted = new Set([pubkey]);
  const advertise = (overrides: Partial<EventTemplate> = {}, key = secretKey) =>
    finalizeEvent({
      kind: 31_990,
      created_at: 1_000,
      tags: [["d", "zap-stream-core"], ["k", "30311"], ["i", "api:zap-stream"]],
      content: JSON.stringify({website: "https://api-uk.zap.stream/api/v1/"}),
      ...overrides,
    }, key);

  it("resolves the primary advertisement instead of a newer regional alternative", () => {
    const primary = advertise();
    const regional = advertise({
      created_at: 2_000,
      tags: [["d", "zap-stream-core-ca"], ["k", "30311"], ["i", "api:zap-stream"]],
      content: JSON.stringify({website: "https://api-ca.zap.stream/api/v1"}),
    });
    expect(getDefaultProviderAdvertisement([regional, primary], trusted)).toEqual({
      pubkey, identifier: "zap-stream-core", url: "https://api-uk.zap.stream/api/v1",
    });
  });

  it("follows the latest endpoint replacement and rejects the retired URL", () => {
    const old = advertise({content: JSON.stringify({website: "https://api-core.zap.stream/api/v1"})});
    const current = advertise({created_at: 2_000});
    expect(getDefaultProviderAdvertisement([old, current], trusted)?.url)
      .toBe("https://api-uk.zap.stream/api/v1");
    expect(getAdvertisedProviderPubkey([old, current], "https://api-core.zap.stream/api/v1", trusted))
      .toBeUndefined();
    expect(getAdvertisedProviderPubkey([old, current], "https://api-uk.zap.stream/api/v1/", trusted))
      .toBe(pubkey);
  });

  it("ignores untrusted authors and invalid signatures", () => {
    const untrusted = advertise({}, new Uint8Array(32).fill(3));
    // Match relay JSON: finalized local events carry a cached verification symbol.
    const invalid = {...JSON.parse(JSON.stringify(advertise())), sig: "0".repeat(128)};
    expect(getDefaultProviderAdvertisement([untrusted, invalid], trusted)).toBeUndefined();
  });

  it.each([
    {kind: 1},
    {tags: [["d", "zap-stream-core"], ["k", "1"], ["i", "api:zap-stream"]]},
    {tags: [["d", "zap-stream-core"], ["k", "30311"]]},
    {content: "not json"},
    {content: "null"},
    {content: JSON.stringify({website: "http://provider.example/api/v1"})},
    {content: JSON.stringify({website: "https://user:password@provider.example/api/v1"})},
  ])("rejects incompatible or malformed advertisements (%j)", (overrides) => {
    expect(getDefaultProviderAdvertisement([advertise(overrides)], trusted)).toBeUndefined();
  });

  it("does not resurrect an old endpoint after a malformed or incompatible replacement", () => {
    const old = advertise();
    for (const replacement of [
      advertise({created_at: 2_000, content: "{}"}),
      advertise({created_at: 2_000, tags: [["d", "zap-stream-core"], ["k", "1"]]}),
    ]) {
      expect(getDefaultProviderAdvertisement([old, replacement], trusted)).toBeUndefined();
    }
  });

  it("returns no default when relay discovery returns nothing", () => {
    expect(getDefaultProviderAdvertisement([], trusted)).toBeUndefined();
  });
});
