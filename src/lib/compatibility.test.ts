import { describe, expect, it } from "vitest";
import type { CommunityWidgetContext } from "budabit-sdk";
import type { Event } from "nostr-tools/pure";
import {
  canConnectProvider,
  classifyCommunityError,
  getCapabilityFailurePolicy,
  getChatPollSince,
  getContextTransitionPolicy,
  getHostCapabilityCatalog,
  getHostCapabilityPolicy,
  getNextPreparedMirrorEvent,
  getPollDelay,
  isPreparedMirrorEligible,
  type PreparedMirrorSession,
} from "./compatibility";
import { COMMUNITY_TAG_PREFIX, LIVE_STREAM_KIND } from "./streams";

const viewer = "a".repeat(64);
const community = "b".repeat(64);
const provider = "c".repeat(64);
const sessionTag = "budabit-stream-session:test";

const context = (
  viewerPubkey: string | undefined,
  overrides: Partial<CommunityWidgetContext> = {},
): CommunityWidgetContext => ({
  version: 1,
  contextSessionId: "session",
  contextVersion: 1,
  pubkey: community,
  ncommunity: "ncommunity1test",
  relays: ["wss://community.example"],
  relayHints: [],
  blossomServers: [],
  sections: [{ name: "main", kinds: [{ kind: 1 }] }],
  viewer: { pubkey: viewerPubkey, isOwner: false, isBanned: false },
  ...overrides,
});

const event = (overrides: Partial<Event> = {}): Event => ({
  id: "d".repeat(64),
  pubkey: provider,
  created_at: 1_010,
  kind: LIVE_STREAM_KIND,
  content: "",
  sig: "e".repeat(128),
  tags: [
    ["d", "prepared-stream"],
    ["t", `${COMMUNITY_TAG_PREFIX}${community}`],
    ["p", viewer, "", "host"],
    ["t", sessionTag],
    ["status", "live"],
  ],
  ...overrides,
});

describe("transient community errors", () => {
  it.each(["COMMUNITY_CONTEXT_NOT_READY", "COMMUNITY_QUERY_TIMEOUT"])(
    "classifies %s as retryable",
    (code) => {
      expect(classifyCommunityError({ code })).toBe("transient");
    },
  );

  it("classifies other errors as terminal and caps retry backoff", () => {
    expect(classifyCommunityError({ code: "PERMISSION_DENIED" })).toBe(
      "terminal",
    );
    expect(getPollDelay("transient", 1)).toBe(1_500);
    expect(getPollDelay("transient", 20)).toBe(30_000);
    expect(getPollDelay("unavailable", 1)).toBeNull();
  });

  it("retains authority only for transient capability failures", () => {
    expect(
      getCapabilityFailurePolicy({ code: "COMMUNITY_QUERY_TIMEOUT" }),
    ).toEqual({ outcome: "transient", retainAuthority: true });
    expect(getCapabilityFailurePolicy({ code: "PERMISSION_DENIED" })).toEqual({
      outcome: "terminal",
      retainAuthority: false,
    });
  });
});

describe("host capability policy", () => {
  it("keeps an absent catalog legacy optimistic", () => {
    const policy = getHostCapabilityPolicy(getHostCapabilityCatalog({}));
    expect(Object.values(policy).every(Boolean)).toBe(true);
  });

  it("applies a present catalog additively", () => {
    const catalog = getHostCapabilityCatalog({
      capabilities: {
        schemaVersion: 1,
        protocolVersion: 1,
        actions: ["community:queryLiveStreams", "nostr:sign"],
      },
    });
    const policy = getHostCapabilityPolicy(catalog);
    expect(policy).toEqual({
      "community:queryLiveStreams": true,
      "community:checkWriteCapabilities": false,
      "nostr:sign": true,
      "nostr:publish": false,
    });
    expect(canConnectProvider(true, viewer, policy)).toBe(false);
  });
});

describe("community context transitions", () => {
  it("retains streams but drops viewer-bound state after login", () => {
    expect(getContextTransitionPolicy(context(undefined), context(viewer))).toEqual(
      {
        retainStreams: true,
        retainCapabilities: false,
        retainProviderSession: false,
      },
    );
  });

  it("revokes viewer-bound authority on a context version change", () => {
    const next = context(viewer, {
      contextVersion: 2,
      relays: ["wss://new-community.example"],
    });
    expect(getContextTransitionPolicy(context(viewer), next)).toEqual({
      retainStreams: true,
      retainCapabilities: false,
      retainProviderSession: false,
    });
  });

  it("revokes capabilities and preparation across host sessions", () => {
    const next = context(viewer, { contextSessionId: "new-session" });
    expect(getContextTransitionPolicy(context(viewer), next)).toEqual({
      retainStreams: true,
      retainCapabilities: false,
      retainProviderSession: false,
    });
  });

  it("retains authority only for an identical authority context", () => {
    expect(getContextTransitionPolicy(context(viewer), context(viewer))).toEqual({
      retainStreams: true,
      retainCapabilities: true,
      retainProviderSession: true,
    });
  });

  it("revokes authority when owner or ban state changes", () => {
    const previous = context(viewer, {
      viewer: { pubkey: viewer, isOwner: true, isBanned: false },
    });
    const next = context(viewer, {
      viewer: { pubkey: viewer, isOwner: false, isBanned: true },
    });
    expect(getContextTransitionPolicy(previous, next)).toEqual({
      retainStreams: true,
      retainCapabilities: false,
      retainProviderSession: false,
    });
  });
});

describe("prepared replacement mirroring", () => {
  const session: PreparedMirrorSession = {
    communityPubkey: community,
    viewerPubkey: viewer,
    contextSessionId: "session",
    preparedAt: 1_000,
    expiresAt: 2_000,
    sessionTag,
    providerBaseUrl: "https://provider.example/api/v1",
    streamAddress: `${LIVE_STREAM_KIND}:${provider}:prepared-stream`,
    providerPubkey: provider,
  };
  const current = {
    communityPubkey: community,
    viewerPubkey: viewer,
    contextSessionId: "session",
    canModerate: true,
  };

  it("accepts only the current prepared provider address", () => {
    expect(
      isPreparedMirrorEligible(event(), session, current, new Set([provider]), 1_100),
    ).toBe(true);
    expect(
      isPreparedMirrorEligible(
        event({
          tags: [
            ["d", "someone-elses-stream"],
            ["t", `${COMMUNITY_TAG_PREFIX}${community}`],
            ["p", viewer, "", "host"],
            ["t", sessionTag],
            ["status", "live"],
          ],
        }),
        session,
        current,
        new Set([provider]),
        1_100,
      ),
    ).toBe(false);
  });

  it("rejects a viewer or moderator transition", () => {
    expect(
      isPreparedMirrorEligible(
        event(),
        session,
        { ...current, viewerPubkey: "f".repeat(64) },
        new Set([provider]),
        1_100,
      ),
    ).toBe(false);
    expect(
      isPreparedMirrorEligible(
        event(),
        session,
        { ...current, canModerate: false },
        new Set([provider]),
        1_100,
      ),
    ).toBe(false);
  });

  it("rejects unrelated and ended initial candidates", () => {
    const unboundSession = {
      ...session,
      streamAddress: undefined,
    };
    expect(
      isPreparedMirrorEligible(
        event({
          tags: [
            ["d", "unrelated"],
            ["t", `${COMMUNITY_TAG_PREFIX}${community}`],
            ["p", viewer, "", "host"],
            ["status", "live"],
          ],
        }),
        unboundSession,
        current,
        new Set([provider]),
        1_100,
      ),
    ).toBe(false);
    expect(
      isPreparedMirrorEligible(
        event({
          tags: event().tags.map((tag) =>
            tag[0] === "status" ? ["status", "ended"] : tag,
          ),
        }),
        unboundSession,
        current,
        new Set([provider]),
        1_100,
      ),
    ).toBe(false);
  });

  it("accepts an ended replacement with recording metadata once pinned", () => {
    const ended = event({
      id: "0".repeat(64),
      created_at: 1_020,
      tags: [
        ...event().tags.filter((tag) => tag[0] !== "status"),
        ["status", "ended"],
        ["ends", "1020"],
        ["recording", "https://video.example/recording.m3u8"],
      ],
    });

    expect(
      isPreparedMirrorEligible(
        ended,
        session,
        current,
        new Set([provider]),
        1_100,
      ),
    ).toBe(true);
    expect(
      isPreparedMirrorEligible(
        ended,
        { ...session, streamAddress: undefined },
        current,
        new Set([provider]),
        1_100,
      ),
    ).toBe(false);
  });

  it("polls the newest terminal replacement once without falling back to live", () => {
    const live = event({ id: "f".repeat(64), created_at: 1_010 });
    const ended = event({
      id: "0".repeat(64),
      created_at: 1_020,
      tags: event().tags.map((tag) =>
        tag[0] === "status" ? ["status", "ended"] : tag,
      ),
    });
    const trusted = new Set([provider]);

    expect(
      getNextPreparedMirrorEvent(
        [live, ended],
        session,
        current,
        trusted,
        new Set(),
        1_100,
      ),
    ).toBe(ended);
    expect(
      getNextPreparedMirrorEvent(
        [live, ended],
        session,
        current,
        trusted,
        new Set([ended.id]),
        1_100,
      ),
    ).toBeUndefined();
  });

  it("rejects a different expected provider or identifier", () => {
    expect(
      isPreparedMirrorEligible(
        event(),
        { ...session, providerPubkey: "f".repeat(64) },
        current,
        new Set([provider, "f".repeat(64)]),
        1_100,
      ),
    ).toBe(false);
    expect(
      isPreparedMirrorEligible(
        event(),
        { ...session, streamAddress: undefined, streamIdentifier: "expected" },
        current,
        new Set([provider]),
        1_100,
      ),
    ).toBe(false);
  });
});

describe("chat polling cursor", () => {
  it("clamps a future event to wall clock before applying overlap", () => {
    expect(
      getChatPollSince([{ created_at: 1_005 }, { created_at: 9_999 }], 1_010),
    ).toBe(1_005);
  });

  it("returns no cursor when there are no finite timestamps", () => {
    expect(getChatPollSince([], 1_010)).toBeUndefined();
  });
});
