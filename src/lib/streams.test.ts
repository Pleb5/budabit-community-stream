import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools/pure";
import {
  ENDED_STREAM_RETENTION_SECONDS,
  LIVE_STREAM_KIND,
  buildEndedStreamTemplate,
  retainVisibleStreams,
  selectLatestStreamReplacements,
  selectNewerStreamReplacement,
  type CommunityStream,
  type StreamStatus,
} from "./streams";

const now = 2_000_000_000;

const stream = (
  status: StreamStatus,
  createdAt: number,
  ends?: number,
  starts?: number,
): CommunityStream => {
  const event = {
    id: `${status}-${createdAt}`,
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind: LIVE_STREAM_KIND,
    content: "",
    sig: "b".repeat(128),
    tags: [["d", `${status}-${createdAt}`]],
  } as Event;
  return {
    event,
    address: `${LIVE_STREAM_KIND}:${event.pubkey}:${status}-${createdAt}`,
    identifier: `${status}-${createdAt}`,
    title: status,
    summary: "",
    image: "",
    thumbnail: "",
    status,
    ends,
    starts,
    playbackUrl: "",
    recordingUrl: status === "vod" ? "https://video.example/vod.mp4" : "",
    host: event.pubkey,
    service: "",
    relays: [],
  };
};

describe("stream retention", () => {
  it("never hides old planned or live replacements", () => {
    const old = now - ENDED_STREAM_RETENTION_SECONDS * 10;
    expect(
      retainVisibleStreams([stream("planned", old), stream("live", old)], now),
    ).toHaveLength(2);
  });

  it("retains recent ended/VOD streams and drops old ones client-side", () => {
    const recent = now - ENDED_STREAM_RETENTION_SECONDS + 1;
    const old = now - ENDED_STREAM_RETENTION_SECONDS - 1;
    const retained = retainVisibleStreams(
      [stream("ended", old, recent), stream("vod", old, old)],
      now,
    );
    expect(retained.map(({ status }) => status)).toEqual(["ended"]);
  });

  it("uses fresh replacement time ahead of an old start for replay retention", () => {
    const recent = now - 60;
    const old = now - ENDED_STREAM_RETENTION_SECONDS - 1;
    expect(retainVisibleStreams([stream("vod", recent, undefined, old)], now)).toHaveLength(
      1,
    );
    expect(retainVisibleStreams([stream("vod", recent, old, recent)], now)).toHaveLength(
      0,
    );
  });
});

describe("stream replacement polling", () => {
  it("lets a newer ended recording supersede older live state", () => {
    const address = `${LIVE_STREAM_KIND}:${"a".repeat(64)}:broadcast`;
    const live = stream("live", now - 20);
    const ended = {
      ...stream("ended", now - 10, now - 10),
      address,
      identifier: "broadcast",
      recordingUrl: "https://video.example/recording.m3u8",
    };
    live.address = address;
    live.identifier = "broadcast";

    expect(selectLatestStreamReplacements([live, ended])).toEqual([ended]);
  });

  it("picks a newer provider replacement for the exact stream coordinate and community", () => {
    const communityId = "0a8ecba4868c13e1e84cc5cb58c02c1fd0880d9e5a25a5050ee96ad8a166d7c8";
    const live = stream("live", now - 100);
    live.identifier = "demo-day";
    live.event.tags = [
      ["d", "demo-day"],
      ["status", "live"],
      ["streaming", "https://stream.example/live.m3u8"],
      ["t", `budabit-community:${communityId}`],
    ];
    const olderEnded: Event = {
      ...live.event,
      id: "older",
      created_at: now - 120,
      tags: [["d", "demo-day"], ["status", "ended"], ["t", `budabit-community:${communityId}`]],
    };
    const wrongAuthor: Event = {
      ...live.event,
      id: "spoof",
      pubkey: "c".repeat(64),
      created_at: now - 10,
      tags: [["d", "demo-day"], ["status", "ended"], ["t", `budabit-community:${communityId}`]],
    };
    const newerEnded: Event = {
      ...live.event,
      id: "ended-real",
      created_at: now - 20,
      tags: [["d", "demo-day"], ["status", "ended"], ["ends", String(now - 20)], ["t", `budabit-community:${communityId}`]],
    };

    expect(
      selectNewerStreamReplacement(live, [olderEnded, wrongAuthor, newerEnded], communityId),
    ).toEqual(newerEnded);

    const endedTemplate = buildEndedStreamTemplate(live, now);
    expect(endedTemplate.tags).toContainEqual(["status", "ended"]);
    expect(endedTemplate.tags).toContainEqual(["ends", String(now)]);
    expect(endedTemplate.tags.some((tag) => tag[0] === "streaming")).toBe(false);
  });
});
