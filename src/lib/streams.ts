import type { Event } from "nostr-tools/pure";
import { naddrEncode } from "nostr-tools/nip19";

export const LIVE_STREAM_KIND = 30311;
export const LIVE_CHAT_KIND = 1311;
export const COMMUNITY_TAG_PREFIX = "budabit-community:";

export type StreamStatus = "planned" | "live" | "ended" | "vod";

export type CommunityStream = {
  event: Event;
  address: string;
  identifier: string;
  title: string;
  summary: string;
  image: string;
  thumbnail: string;
  status: StreamStatus;
  starts?: number;
  ends?: number;
  playbackUrl: string;
  recordingUrl: string;
  host: string;
  service: string;
  participants?: number;
  relays: string[];
};

export const tagValue = (event: Event, name: string) =>
  event.tags.find((tag) => tag[0] === name)?.[1]?.trim() || "";

export const getStreamAddress = (event: Event) => {
  const identifier = tagValue(event, "d");
  return identifier ? `${LIVE_STREAM_KIND}:${event.pubkey}:${identifier}` : "";
};

export const hasCommunityTag = (event: Event, communityPubkey: string) => {
  const normalized = communityPubkey.toLowerCase();
  return event.tags.some((tag) => {
    const value = tag[1]?.trim().toLowerCase();
    return (
      (tag[0] === "h" && value === normalized) ||
      (tag[0] === "t" &&
        (value === normalized ||
          value === `${COMMUNITY_TAG_PREFIX}${normalized}`))
    );
  });
};

export const getHostPubkey = (event: Event, trustedProviders: Set<string>) => {
  if (!trustedProviders.has(event.pubkey)) return event.pubkey;
  return (
    event.tags.find(
      (tag) => tag[0] === "p" && tag[1] && tag[3]?.toLowerCase() === "host",
    )?.[1] || event.pubkey
  );
};

const parseTimestamp = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

const playableUrl = (value: string) => {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" || (local && url.protocol === "http:")
      ? url.toString()
      : "";
  } catch {
    return "";
  }
};

export const parseStreamEvent = (
  event: Event,
  trustedProviders: Set<string>,
): CommunityStream | null => {
  if (event.kind !== LIVE_STREAM_KIND) return null;
  const identifier = tagValue(event, "d");
  if (!identifier) return null;
  const streamingUrls = event.tags
    .filter((tag) => tag[0] === "streaming")
    .map((tag) => playableUrl(tag[1] || ""))
    .filter(Boolean);
  const rawStatus = tagValue(event, "status");
  const status: StreamStatus = ["planned", "live", "ended", "vod"].includes(
    rawStatus,
  )
    ? (rawStatus as StreamStatus)
    : streamingUrls.length
      ? "live"
      : "planned";
  const relayUrls = event.tags
    .filter((tag) => tag[0] === "relays")
    .flatMap((tag) => tag.slice(1))
    .filter((relay) => relay.startsWith("wss://") || relay.startsWith("ws://"));
  const participants = Number(tagValue(event, "current_participants"));

  return {
    event,
    address: `${LIVE_STREAM_KIND}:${event.pubkey}:${identifier}`,
    identifier,
    title: tagValue(event, "title") || "Community stream",
    summary: tagValue(event, "summary"),
    image: playableUrl(tagValue(event, "image")),
    thumbnail: playableUrl(tagValue(event, "thumb")),
    status,
    starts: parseTimestamp(tagValue(event, "starts")),
    ends: parseTimestamp(tagValue(event, "ends")),
    playbackUrl:
      streamingUrls.find((url) => new URL(url).pathname.includes(".m3u8")) ||
      streamingUrls[0] ||
      "",
    recordingUrl: playableUrl(
      tagValue(event, "recording") || tagValue(event, "url"),
    ),
    host: getHostPubkey(event, trustedProviders),
    service: playableUrl(tagValue(event, "service")),
    participants:
      Number.isFinite(participants) && participants >= 0
        ? participants
        : undefined,
    relays: Array.from(new Set(relayUrls)),
  };
};

export const streamNaddr = (stream: CommunityStream, relays: string[]) =>
  naddrEncode({
    kind: LIVE_STREAM_KIND,
    pubkey: stream.event.pubkey,
    identifier: stream.identifier,
    relays: Array.from(new Set(relays)).slice(0, 5),
  });
