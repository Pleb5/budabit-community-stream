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
};

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

  updateStream(details: StreamDetails) {
    return this.request<Record<string, never>>("PATCH", "event", details);
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
