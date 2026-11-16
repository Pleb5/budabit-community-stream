import type { NostrSignResponse, WidgetBridge } from "budabit-sdk";
import { verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";

export type ProviderMethod = "GET" | "PATCH" | "POST" | "DELETE";

export type StreamDetails = {
  id?: string;
  title?: string;
  summary?: string;
  image?: string;
  tags?: string[];
  content_warning?: string;
  goal?: string;
};

export type IngestEndpoint = {
  name: string;
  url: string;
  key: string;
  cost: { unit: string; rate: number };
  capabilities: string[];
};

export type ProviderAccount = {
  balance: number;
  endpoints: IngestEndpoint[];
  tos?: { accepted: boolean; link: string };
  details?: StreamDetails;
  provider_pubkey?: string;
  service_pubkey?: string;
};

export type StreamUpdateResult = StreamDetails & {
  details?: StreamDetails;
  provider_pubkey?: string;
  service_pubkey?: string;
};

const validIdentifier = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const trustedProviderHint = (
  values: unknown[],
  trustedProviders: ReadonlySet<string>,
) =>
  values.find(
    (value): value is string =>
      typeof value === "string" && trustedProviders.has(value.toLowerCase()),
  )?.toLowerCase();

export const getProviderPreparationBinding = (
  account: ProviderAccount,
  update: StreamUpdateResult | null | undefined,
  trustedProviders: ReadonlySet<string>,
) => ({
  streamIdentifier:
    validIdentifier(update?.id) ||
    validIdentifier(update?.details?.id) ||
    validIdentifier(account.details?.id),
  providerPubkey: trustedProviderHint(
    [
      update?.provider_pubkey,
      update?.service_pubkey,
      account.provider_pubkey,
      account.service_pubkey,
    ],
    trustedProviders,
  ),
});

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export const normalizeProviderUrl = (value: string) => {
  const raw = value.trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("The provider must use HTTPS");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
};

export const PROVIDER_ADVERTISEMENT_KIND = 31_990;

export type ProviderAdvertisement = {
  pubkey: string;
  identifier: string;
  url: string;
};

const getProviderAdvertisements = (
  events: Event[],
  trustedProviders: ReadonlySet<string>,
): ProviderAdvertisement[] => {
  const latest = new Map<string, Event>();
  // Select addressable replacements before parsing metadata, so an invalid new
  // advertisement cannot resurrect an obsolete endpoint from an older event.
  for (const event of [...events].sort(
    (left, right) =>
      right.created_at - left.created_at || left.id.localeCompare(right.id),
  )) {
    if (
      event.kind !== PROVIDER_ADVERTISEMENT_KIND ||
      !trustedProviders.has(event.pubkey.toLowerCase()) ||
      !verifyEvent(event)
    ) continue;
    const identifier = event.tags.find((tag) => tag[0] === "d")?.[1];
    if (!identifier) continue;
    const address = `${event.pubkey}:${identifier}`;
    if (!latest.has(address)) latest.set(address, event);
  }
  return [...latest.values()].flatMap((event) => {
    if (
      !event.tags.some((tag) => tag[0] === "k" && tag[1] === "30311") ||
      !event.tags.some((tag) => tag[0] === "i" && tag[1] === "api:zap-stream")
    ) return [];
    try {
      const metadata = JSON.parse(event.content);
      if (typeof metadata?.website !== "string") return [];
      const url = new URL(metadata.website);
      if (url.protocol !== "https:" || url.username || url.password) return [];
      return [{
        pubkey: event.pubkey.toLowerCase(),
        identifier: event.tags.find((tag) => tag[0] === "d")![1],
        url: normalizeProviderUrl(metadata.website),
      }];
    } catch {
      return [];
    }
  });
};

export const getDefaultProviderAdvertisement = (
  events: Event[],
  trustedProviders: ReadonlySet<string>,
) => {
  const advertisements = getProviderAdvertisements(events, trustedProviders);
  // zap.stream advertises regional alternatives separately. Prefer its primary
  // service even if a regional advertisement was published more recently.
  return advertisements.find((item) => item.identifier === "zap-stream-core") ||
    advertisements[0];
};

export const getAdvertisedProviderPubkey = (
  events: Event[],
  baseUrl: string,
  trustedProviders: ReadonlySet<string>,
) => getProviderAdvertisements(events, trustedProviders)
  .find((advertisement) => advertisement.url === normalizeProviderUrl(baseUrl))
  ?.pubkey;

export class StreamProviderClient {
  private offsetMs = 0;

  constructor(
    private bridge: WidgetBridge,
    readonly baseUrl: string,
  ) {}

  async syncClock() {
    try {
      const startedAt = Date.now();
      const response = await fetch(`${this.baseUrl}/time`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return;
      const value = Number((await response.json()).time);
      if (!Number.isFinite(value)) return;
      const serverTimeMs = value < 10_000_000_000 ? value * 1000 : value;
      this.offsetMs = serverTimeMs - startedAt;
    } catch {
      this.offsetMs = 0;
    }
  }

  account() {
    return this.request<ProviderAccount>("GET", "account");
  }

  async updateStream(details: StreamDetails): Promise<StreamUpdateResult> {
    // zap-stream-core's update handler returns unit, serialized as JSON null.
    // A successful update need not return a stream ID or provider identity.
    const result = await this.request<StreamUpdateResult | null>(
      "PATCH", "event", details,
    );
    return result ?? {};
  }

  acceptTerms() {
    return this.request<Record<string, never>>("PATCH", "account", {
      accept_tos: true,
    });
  }

  private async request<T>(
    method: ProviderMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/${path.replace(/^\//, "")}`;
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    const tags = [
      ["u", url],
      ["method", method],
    ];
    if (bodyText !== undefined)
      tags.push(["payload", await sha256Hex(bodyText)]);

    const template: EventTemplate = {
      kind: 27235,
      created_at: Math.floor((Date.now() + this.offsetMs) / 1000),
      content: "",
      tags,
    };
    const signed = (await this.bridge.request(
      "nostr:sign",
      template,
    )) as NostrSignResponse;
    if ("error" in signed) throw new Error(signed.error);
    const authEvent = signed.event as Event;
    if (!verifyEvent(authEvent))
      throw new Error("The provider authorization signature is invalid");
    const authorization = `Nostr ${bytesToBase64(new TextEncoder().encode(JSON.stringify(authEvent)))}`;
    const response = await fetch(url, {
      method,
      body: bodyText,
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization,
        ...(bodyText === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
    const responseText = await response.text();
    if (!response.ok) {
      let message = responseText || `${response.status} ${response.statusText}`;
      try {
        const parsed = JSON.parse(responseText);
        message = parsed.error || parsed.message || message;
      } catch {
        // The provider may return a plain-text error.
      }
      throw new Error(message);
    }
    return responseText ? (JSON.parse(responseText) as T) : ({} as T);
  }
}
