import type { CommunityWidgetContext } from "budabit-sdk";
import type { Event } from "nostr-tools/pure";
import { getStreamAddress, hasCommunityTag } from "./streams";

export const TRANSIENT_COMMUNITY_ERROR_CODES = new Set([
  "COMMUNITY_CONTEXT_NOT_READY",
  "COMMUNITY_QUERY_TIMEOUT",
]);

export type LoadOutcome =
  | "success"
  | "transient"
  | "terminal"
  | "unavailable"
  | "skipped";

export const classifyCommunityError = (value: unknown) => {
  if (!value || typeof value !== "object") return "terminal" as const;
  const code = "code" in value ? value.code : undefined;
  return typeof code === "string" && TRANSIENT_COMMUNITY_ERROR_CODES.has(code)
    ? ("transient" as const)
    : ("terminal" as const);
};

export const getCapabilityFailurePolicy = (value: unknown) => {
  const outcome = classifyCommunityError(value);
  return { outcome, retainAuthority: outcome === "transient" };
};

export const getPollDelay = (
  outcome: LoadOutcome,
  consecutiveFailures: number,
) => {
  if (outcome === "success") return 10_000;
  if (outcome === "skipped") return 1_000;
  if (outcome === "terminal") return 30_000;
  if (outcome === "unavailable") return null;
  return Math.min(1_500 * 2 ** Math.max(0, consecutiveFailures - 1), 30_000);
};

export type HostCapabilityAction =
  | "community:queryLiveStreams"
  | "community:checkWriteCapabilities"
  | "nostr:sign"
  | "nostr:publish";

export type HostCapabilityPolicy = Record<HostCapabilityAction, boolean>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const stringCatalog = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  return Array.from(
    new Set(value.filter((item): item is string => typeof item === "string")),
  );
};

export const getHostCapabilityCatalog = (payload: unknown): string[] | null => {
  const record = asRecord(payload);
  if (!record) return null;
  const candidate =
    record.capabilityCatalog ?? record.hostCapabilities ?? record.capabilities;
  const direct = stringCatalog(candidate);
  if (direct) return direct;
  const catalog = asRecord(candidate);
  return catalog
    ? stringCatalog(catalog.actions ?? catalog.bridgeActions)
    : null;
};

export const getHostCapabilityPolicy = (
  catalog: readonly string[] | null,
): HostCapabilityPolicy => {
  const supports = (action: HostCapabilityAction) =>
    catalog === null || catalog.includes(action);
  return {
    "community:queryLiveStreams": supports("community:queryLiveStreams"),
    "community:checkWriteCapabilities": supports(
      "community:checkWriteCapabilities",
    ),
    "nostr:sign": supports("nostr:sign"),
    "nostr:publish": supports("nostr:publish"),
  };
};

const descriptorSignature = (ctx: CommunityWidgetContext | null) =>
  (ctx?.sections || [])
    .flatMap((section) =>
      (section.kinds || []).map(
        ({ kind, subtype }) =>
          `${section.name}:${Math.floor(kind)}:${subtype || ""}`,
      ),
    )
    .sort()
    .join("|");

export const getContextTransitionPolicy = (
  previous: CommunityWidgetContext | null,
  next: CommunityWidgetContext | null,
) => {
  const sameCommunity = Boolean(
    previous && next && previous.definitionAddress === next.definitionAddress,
  );
  const sameSession = Boolean(
    sameCommunity && previous?.contextSessionId === next?.contextSessionId,
  );
  const sameViewer = Boolean(
    sameCommunity &&
    previous?.viewer.pubkey === next?.viewer.pubkey &&
    previous?.viewer.isOwner === next?.viewer.isOwner &&
    previous?.viewer.isBanned === next?.viewer.isBanned,
  );
  const sameVersion = Boolean(
    sameSession && previous?.contextVersion === next?.contextVersion,
  );
  return {
    retainStreams: sameCommunity,
    retainCapabilities:
      sameVersion &&
      sameViewer &&
      descriptorSignature(previous) === descriptorSignature(next),
    retainProviderSession:
      sameVersion && sameViewer && Boolean(next?.viewer.pubkey),
  };
};

export const canConnectProvider = (
  canModerate: boolean,
  viewerPubkey: string | undefined,
  policy: HostCapabilityPolicy,
) =>
  canModerate &&
  Boolean(viewerPubkey) &&
  policy["nostr:sign"] &&
  policy["nostr:publish"];

export type PreparedMirrorSession = {
  communityId: string;
  viewerPubkey: string;
  contextSessionId: string;
  preparedAt: number;
  expiresAt: number;
  sessionTag: string;
  providerBaseUrl: string;
  streamIdentifier?: string;
  streamAddress?: string;
  providerPubkey: string;
};

export type CurrentMirrorContext = {
  communityId: string;
  viewerPubkey?: string;
  contextSessionId: string;
  canModerate: boolean;
};

export const isPreparedMirrorEligible = (
  event: Event,
  session: PreparedMirrorSession | null,
  current: CurrentMirrorContext,
  trustedProviders: ReadonlySet<string>,
  now = Math.floor(Date.now() / 1000),
) => {
  if (!session || !current.canModerate) return false;
  if (
    session.communityId !== current.communityId ||
    session.viewerPubkey !== current.viewerPubkey ||
    session.contextSessionId !== current.contextSessionId ||
    now > session.expiresAt ||
    event.created_at < session.preparedAt - 60 ||
    event.created_at > now + 120 ||
    event.created_at > session.expiresAt ||
    !trustedProviders.has(event.pubkey) ||
    event.pubkey !== session.providerPubkey ||
    !event.tags.some(
      (tag) => tag[0] === "t" && tag[1] === session.sessionTag,
    ) ||
    !hasCommunityTag(event, current.communityId) ||
    !event.tags.some(
      (tag) =>
        tag[0] === "p" &&
        tag[1] === current.viewerPubkey &&
        tag[3]?.toLowerCase() === "host",
    )
  ) {
    return false;
  }
  const address = getStreamAddress(event);
  const identifier = address.split(":").slice(2).join(":");
  const status = event.tags.find((tag) => tag[0] === "status")?.[1];
  const eligibleStatus =
    status === "live" ||
    status === "planned" ||
    (status === "ended" && Boolean(session.streamAddress));
  return Boolean(
    address &&
    eligibleStatus &&
    (!session.streamIdentifier || identifier === session.streamIdentifier) &&
    (!session.streamAddress || address === session.streamAddress),
  );
};

export const getNextPreparedMirrorEvent = (
  events: Event[],
  session: PreparedMirrorSession | null,
  current: CurrentMirrorContext,
  trustedProviders: ReadonlySet<string>,
  mirroredEventIds: ReadonlySet<string>,
  now = Math.floor(Date.now() / 1000),
) => {
  const latest = [...events]
    .sort(
      (left, right) =>
        right.created_at - left.created_at || left.id.localeCompare(right.id),
    )
    .find((event) =>
      isPreparedMirrorEligible(event, session, current, trustedProviders, now),
    );
  return latest && !mirroredEventIds.has(latest.id) ? latest : undefined;
};

export const getChatPollSince = (
  events: Array<{ created_at: number }>,
  now = Math.floor(Date.now() / 1000),
  overlapSeconds = 5,
) => {
  const latest = events.reduce(
    (value, event) =>
      Number.isFinite(event.created_at)
        ? Math.max(value, Math.floor(event.created_at))
        : value,
    0,
  );
  return latest
    ? Math.max(0, Math.min(latest, now) - Math.max(0, overlapSeconds))
    : undefined;
};
