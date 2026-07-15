<script lang="ts">
  import {
    createWidgetBridge,
    type CommunityEventDescriptor,
    type CommunityWidgetContext,
    type CommunityWriteCapability,
    type NostrPublishResponse,
    type NostrSignResponse,
    type WidgetBridge,
    type WidgetInitPayload,
  } from "budabit-sdk";
  import { SimplePool, type SubCloser } from "nostr-tools/pool";
  import {
    verifyEvent,
    type Event,
    type EventTemplate,
  } from "nostr-tools/pure";
  import HlsPlayer from "./HlsPlayer.svelte";
  import {
    COMMUNITY_TAG_PREFIX,
    LIVE_CHAT_KIND,
    LIVE_STREAM_KIND,
    getStreamAddress,
    hasCommunityTag,
    parseStreamEvent,
    streamNaddr,
    type CommunityStream,
  } from "./lib/streams";
  import {
    normalizeProviderUrl,
    StreamProviderClient,
    type IngestEndpoint,
    type ProviderAccount,
  } from "./lib/provider";

  type WidgetTheme = "light" | "dark";
  type ContextResponse = { contextSessionId?: string; contextVersion?: number };
  type PublishRelayResult = {
    relay: string;
    status: "fulfilled" | "rejected";
    reason?: string;
  };
  type PublishResult = {
    publishResult?: PublishRelayResult[];
    successCount?: number;
  };
  type ChatMessage = Event & { delivery?: "sending" };
  type ChatProfile = { name?: string; picture?: string };

  const DEFAULT_PROVIDER_URL =
    import.meta.env.VITE_STREAM_PROVIDER_URL ||
    "https://api-core.zap.stream/api/v1";
  const DEFAULT_PUBLIC_RELAYS = [
    "wss://relay.snort.social",
    "wss://nos.lol",
    "wss://relay.damus.io",
    "wss://relay.divine.video/",
  ];
  const DEFAULT_TRUSTED_PROVIDERS = [
    "cf45a6ba1363ad7ed213a078e710d24115ae721c9b47bd1ebf4458eaefb4c2a5",
    "81ee947168db2f909895dbd4f71534f4040035575f58156e9a3802d1dd467e1d",
    "f6a25b87f7e7bec9a691e37851b1b57a7b49fa00bb431280303002a3ebca4891",
    "85df822a86599ffbe8143db1e1e1bf2d162fa60fc685c65515963e67cfd7499f",
  ];
  const POLL_INTERVAL_MS = 10_000;
  const CHAT_LIMIT = 150;
  const MIN_COLLAPSED_HEIGHT = 76;

  const pool = new SimplePool({ enableReconnect: true });
  const trustedProviders = new Set(
    parseCsv(import.meta.env.VITE_TRUSTED_STREAM_PROVIDER_PUBKEYS).length
      ? parseCsv(import.meta.env.VITE_TRUSTED_STREAM_PROVIDER_PUBKEYS)
      : DEFAULT_TRUSTED_PROVIDERS,
  );
  const configuredPublicRelays = normalizeRelays(
    parseCsv(import.meta.env.VITE_PUBLIC_STREAM_RELAYS).length
      ? parseCsv(import.meta.env.VITE_PUBLIC_STREAM_RELAYS)
      : DEFAULT_PUBLIC_RELAYS,
  );

  let bridge = $state<WidgetBridge | null>(null);
  let initPayload = $state<WidgetInitPayload | null>(null);
  let communityContext = $state<CommunityWidgetContext | null>(null);
  let capabilities = $state<CommunityWriteCapability[]>([]);
  let streams = $state<CommunityStream[]>([]);
  let loadingCapabilities = $state(false);
  let loadingStreams = $state(false);
  let hasLoadedStreams = $state(false);
  let loadError = $state("");
  let expanded = $state(false);
  let joinedAddress = $state("");
  let setupOpen = $state(false);
  let widgetTheme = $state<WidgetTheme>("light");
  let mainElement = $state<HTMLElement | null>(null);
  let lastRequestedHeight = 0;
  let resizeFrame: number | undefined;

  let providerUrl = $state(DEFAULT_PROVIDER_URL);
  let providerClient = $state<StreamProviderClient | null>(null);
  let providerAccount = $state<ProviderAccount | null>(null);
  let providerLoading = $state(false);
  let providerError = $state("");
  let termsAccepted = $state(false);
  let selectedEndpointName = $state("");
  let streamTitle = $state("");
  let streamSummary = $state("");
  let streamImage = $state("");
  let streamTags = $state("");
  let publicRelayInput = $state(configuredPublicRelays.join(", "));
  let prepared = $state(false);
  let preparing = $state(false);
  let launchStatus = $state("");

  let chatMessages = $state<ChatMessage[]>([]);
  let chatProfiles = $state<Record<string, ChatProfile>>({});
  let chatText = $state("");
  let chatLoading = $state(false);
  let chatSending = $state(false);
  let chatError = $state("");
  let messagesElement = $state<HTMLDivElement | null>(null);
  let chatSubscription: SubCloser | null = null;
  let chatSession = 0;
  const requestedChatProfiles = new Set<string>();
  let launchSubscription: SubCloser | null = null;
  const streamSubscriptions = new Map<string, SubCloser>();
  const mirrorPromises = new Map<string, Promise<void>>();

  const descriptors = $derived.by(() =>
    getCommunityDescriptors(communityContext),
  );
  const canModerate = $derived(
    Boolean(
      communityContext?.viewer.isOwner ||
      capabilities.some((capability) => capability.canModerate),
    ),
  );
  const liveStreams = $derived(
    streams.filter((stream) => stream.status === "live"),
  );
  const plannedStreams = $derived(
    streams.filter((stream) => stream.status === "planned"),
  );
  const recentStreams = $derived(
    streams.filter(
      (stream) =>
        (stream.status === "ended" || stream.status === "vod") &&
        stream.recordingUrl,
    ),
  );
  const selectedStream = $derived(
    streams.find((stream) => stream.address === joinedAddress) || null,
  );
  const selectedEndpoint = $derived(
    providerAccount?.endpoints.find(
      (endpoint) => endpoint.name === selectedEndpointName,
    ) ||
      providerAccount?.endpoints[0] ||
      null,
  );
  const selectedPublicRelays = $derived(
    normalizeRelays(parseCsv(publicRelayInput)),
  );
  const publishRelays = $derived(
    normalizeRelays([
      ...(communityContext?.relays || []),
      ...selectedPublicRelays,
    ]),
  );

  function parseCsv(value: unknown) {
    return typeof value === "string"
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  }

  function normalizeRelays(values: string[]) {
    const relays: string[] = [];
    for (const value of values) {
      try {
        const url = new URL(value);
        if (url.protocol !== "wss:" && url.protocol !== "ws:") continue;
        url.hash = "";
        relays.push(url.toString());
      } catch {
        // Ignore invalid relay input.
      }
    }
    return Array.from(new Set(relays));
  }

  function descriptorKey(descriptor: CommunityEventDescriptor) {
    return `${descriptor.kind}:${descriptor.subtype || ""}`;
  }

  function getCommunityDescriptors(
    ctx: CommunityWidgetContext | null,
  ): CommunityEventDescriptor[] {
    const byKey = new Map<string, CommunityEventDescriptor>();
    for (const section of ctx?.sections || []) {
      for (const kind of section.kinds || []) {
        if (!Number.isFinite(kind.kind)) continue;
        const descriptor = {
          kind: Math.floor(kind.kind),
          ...(kind.subtype ? { subtype: kind.subtype } : {}),
        };
        byKey.set(descriptorKey(descriptor), descriptor);
      }
    }
    return Array.from(byKey.values());
  }

  function getCommunityName(ctx = communityContext) {
    return ctx?.profile?.displayName || ctx?.profile?.name || "Community";
  }

  function getContextKey(ctx: CommunityWidgetContext | null) {
    return ctx ? `${ctx.contextSessionId}:${ctx.contextVersion}` : "";
  }

  function contextIsCurrent(expected: CommunityWidgetContext) {
    return getContextKey(communityContext) === getContextKey(expected);
  }

  function responseMatchesContext(
    response: ContextResponse,
    expected: CommunityWidgetContext,
  ) {
    return (
      response.contextSessionId === expected.contextSessionId &&
      response.contextVersion === expected.contextVersion
    );
  }

  function applyTheme(theme: unknown, background?: unknown) {
    widgetTheme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = widgetTheme;
    document.body.dataset.theme = widgetTheme;
    if (typeof background === "string" && background.trim()) {
      document.documentElement.style.setProperty(
        "--host-background",
        background.trim(),
      );
    } else {
      document.documentElement.style.removeProperty("--host-background");
    }
  }

  function resetSetup(ctx: CommunityWidgetContext | null) {
    providerUrl = DEFAULT_PROVIDER_URL;
    providerClient = null;
    providerAccount = null;
    providerError = "";
    providerLoading = false;
    termsAccepted = false;
    selectedEndpointName = "";
    streamTitle = `${getCommunityName(ctx)} live`;
    streamSummary = "";
    streamImage = "";
    streamTags = "";
    publicRelayInput = configuredPublicRelays.join(", ");
    prepared = false;
    preparing = false;
    launchStatus = "";
  }

  function applyCommunityContext(ctx: CommunityWidgetContext | null) {
    communityContext = ctx;
    capabilities = [];
    loadingCapabilities = false;
    streams = [];
    loadingStreams = false;
    hasLoadedStreams = false;
    loadError = "";
    expanded = false;
    joinedAddress = "";
    setupOpen = false;
    closeStreamSubscriptions();
    closeLaunchSubscription();
    stopChat();
    resetSetup(ctx);
    lastRequestedHeight = 0;
    scheduleHostResize();
  }

  async function showToast(
    message: string,
    type: "info" | "success" | "warning" | "error" = "info",
  ) {
    try {
      await bridge?.request("ui:toast", { message, type });
    } catch {
      // Host toasts are best-effort.
    }
  }

  async function refreshCapabilities(ctx = communityContext) {
    if (!bridge || !ctx || loadingCapabilities) return;
    const requestedDescriptors = getCommunityDescriptors(ctx);
    if (!requestedDescriptors.length) return;
    const expected = ctx;
    loadingCapabilities = true;
    try {
      const response = await bridge.request(
        "community:checkWriteCapabilities",
        {
          descriptors: requestedDescriptors,
        },
      );
      if (
        !contextIsCurrent(expected) ||
        "error" in response ||
        !responseMatchesContext(response, expected)
      )
        return;
      capabilities = response.capabilities;
    } catch {
      if (contextIsCurrent(expected)) capabilities = [];
    } finally {
      if (contextIsCurrent(expected)) loadingCapabilities = false;
    }
  }

  async function loadStreams(ctx = communityContext) {
    if (!bridge || !ctx || loadingStreams) return;
    const requestedDescriptors = getCommunityDescriptors(ctx);
    if (!requestedDescriptors.length) {
      loadError =
        "This community has no sections that can authorize stream moderators.";
      return;
    }
    const expected = ctx;
    loadingStreams = true;
    try {
      const response = await bridge.request("community:queryLiveStreams", {
        descriptors: requestedDescriptors,
        limit: 100,
        since: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
      });
      if (!contextIsCurrent(expected)) return;
      if ("error" in response) {
        if (
          !hasLoadedStreams &&
          response.code !== "COMMUNITY_CONTEXT_NOT_READY" &&
          response.code !== "COMMUNITY_QUERY_TIMEOUT"
        ) {
          loadError = response.error;
        }
        return;
      }
      if (!responseMatchesContext(response, expected)) return;
      const wasLoaded = hasLoadedStreams;
      const wasLive = streams.some((stream) => stream.status === "live");
      const nextStreams = response.events
        .filter((event): event is Event => verifyEvent(event as Event))
        .map((event) => parseStreamEvent(event, trustedProviders))
        .filter((stream): stream is CommunityStream => Boolean(stream))
        .sort(compareStreams);
      loadError = "";
      hasLoadedStreams = true;
      if (!sameStreams(streams, nextStreams)) {
        streams = nextStreams;
        syncStreamSubscriptions(nextStreams);
      }
      if (
        nextStreams.some((stream) => stream.status === "live") &&
        (!wasLoaded || !wasLive)
      ) {
        expanded = true;
      }
      if (
        joinedAddress &&
        !nextStreams.some((stream) => stream.address === joinedAddress)
      ) {
        joinedAddress = "";
        stopChat();
      }
    } catch (error) {
      if (contextIsCurrent(expected) && !hasLoadedStreams) {
        loadError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (contextIsCurrent(expected)) loadingStreams = false;
      scheduleHostResize();
    }
  }

  function compareStreams(left: CommunityStream, right: CommunityStream) {
    const order = { live: 0, planned: 1, vod: 2, ended: 3 };
    return (
      order[left.status] - order[right.status] ||
      (right.starts || right.event.created_at) -
        (left.starts || left.event.created_at)
    );
  }

  function sameStreams(current: CommunityStream[], next: CommunityStream[]) {
    return (
      current.length === next.length &&
      current.every((stream, index) => stream.event.id === next[index]?.event.id)
    );
  }

  function toggleExpanded() {
    expanded = !expanded;
    scheduleHostResize();
  }

  function openSetup() {
    if (!canModerate) return;
    expanded = true;
    setupOpen = true;
    providerError = "";
    scheduleHostResize();
  }

  function closeSetup() {
    setupOpen = false;
    scheduleHostResize();
  }

  async function connectProvider() {
    if (!bridge || !communityContext || !canModerate || providerLoading) return;
    providerLoading = true;
    providerError = "";
    prepared = false;
    try {
      const normalized = normalizeProviderUrl(providerUrl);
      providerUrl = normalized;
      const client = new StreamProviderClient(bridge, normalized);
      await client.syncClock();
      const account = await client.account();
      providerClient = client;
      providerAccount = account;
      termsAccepted = account.tos?.accepted !== false;
      selectedEndpointName =
        account.endpoints.find((endpoint) => endpoint.name === "Best")?.name ||
        account.endpoints[0]?.name ||
        "";
      if (account.details?.title) streamTitle = account.details.title;
      if (account.details?.summary) streamSummary = account.details.summary;
      if (account.details?.image) streamImage = account.details.image;
      if (!account.endpoints.length)
        throw new Error("This provider did not return an OBS ingest endpoint.");
    } catch (error) {
      providerClient = null;
      providerAccount = null;
      providerError = error instanceof Error ? error.message : String(error);
    } finally {
      providerLoading = false;
      scheduleHostResize();
    }
  }

  async function acceptProviderTerms() {
    if (!providerClient || providerLoading) return;
    providerLoading = true;
    providerError = "";
    try {
      await providerClient.acceptTerms();
      termsAccepted = true;
      if (providerAccount?.tos) providerAccount.tos.accepted = true;
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
    } finally {
      providerLoading = false;
    }
  }

  async function prepareStream() {
    if (
      !providerClient ||
      !providerAccount ||
      !communityContext ||
      preparing ||
      !selectedEndpoint
    )
      return;
    if (!termsAccepted) {
      providerError = "Accept the provider terms before preparing the stream.";
      return;
    }
    if (!streamTitle.trim()) {
      providerError = "Enter a stream title.";
      return;
    }
    if (!selectedPublicRelays.length) {
      providerError = "Add at least one public Nostr relay.";
      return;
    }
    preparing = true;
    providerError = "";
    launchStatus = "Saving stream metadata...";
    try {
      const communityTag = `${COMMUNITY_TAG_PREFIX}${communityContext.pubkey.toLowerCase()}`;
      const tags = Array.from(
        new Set([
          communityTag,
          ...parseCsv(streamTags).filter((tag) => tag !== communityTag),
        ]),
      );
      await providerClient.updateStream({
        title: streamTitle.trim(),
        summary: streamSummary.trim() || undefined,
        image: normalizeOptionalHttpsUrl(streamImage),
        tags,
      });
      prepared = true;
      launchStatus =
        "OBS is ready. Start streaming to publish the community event.";
      await startLaunchMonitor(communityContext);
      await showToast("Stream prepared. Start streaming from OBS.", "success");
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
      launchStatus = "";
    } finally {
      preparing = false;
      scheduleHostResize();
    }
  }

  function normalizeOptionalHttpsUrl(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const url = new URL(trimmed);
    if (url.protocol !== "https:")
      throw new Error("The stream image must use HTTPS.");
    return url.toString();
  }

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      await showToast(`${label} copied`, "success");
    } catch {
      await showToast(`Unable to copy ${label.toLowerCase()}`, "warning");
    }
  }

  function isHostedBy(event: Event, pubkey: string) {
    return event.tags.some(
      (tag) =>
        tag[0] === "p" && tag[1] === pubkey && tag[3]?.toLowerCase() === "host",
    );
  }

  async function startLaunchMonitor(ctx: CommunityWidgetContext) {
    closeLaunchSubscription();
    const viewerPubkey = ctx.viewer.pubkey;
    if (!viewerPubkey) return;
    const filter = {
      kinds: [LIVE_STREAM_KIND],
      authors: Array.from(trustedProviders),
      "#p": [viewerPubkey],
      "#t": [`${COMMUNITY_TAG_PREFIX}${ctx.pubkey.toLowerCase()}`],
      since: Math.floor(Date.now() / 1000) - 300,
    };
    const handle = (event: Event) => {
      if (!verifyEvent(event) || !trustedProviders.has(event.pubkey)) return;
      if (
        !isHostedBy(event, viewerPubkey) ||
        !hasCommunityTag(event, ctx.pubkey)
      )
        return;
      launchStatus =
        "Provider stream detected. Publishing it to the community relays...";
      void mirrorEvent(event, ctx)
        .then(() => {
          launchStatus = "The community stream is live.";
          void loadStreams(ctx);
        })
        .catch((error) => {
          launchStatus = `Unable to publish the stream to the community relays: ${error instanceof Error ? error.message : String(error)}`;
        });
    };
    void pool
      .querySync(configuredPublicRelays, filter, { maxWait: 3000 })
      .then((events) => events.forEach(handle));
    launchSubscription = pool.subscribeMany(configuredPublicRelays, filter, {
      onevent: handle,
    });
  }

  async function mirrorEvent(event: Event, ctx = communityContext) {
    if (!bridge || !ctx || !verifyEvent(event)) return;
    if (!hasCommunityTag(event, ctx.pubkey)) return;
    const existing = mirrorPromises.get(event.id);
    if (existing) return existing;

    const communityRelays = new Set(normalizeRelays(ctx.relays));
    const promise = bridge
      .request("nostr:publish", {
        event,
        relays: normalizeRelays([...ctx.relays, ...selectedPublicRelays]),
      })
      .then((rawResponse) => {
        const response = rawResponse as NostrPublishResponse;
        if ("error" in response) throw new Error(response.error);

        const result = response.result as PublishResult | undefined;
        const acceptedByCommunity = result?.publishResult?.some(
          ({ relay, status }) =>
            status === "fulfilled" &&
            communityRelays.has(normalizeRelays([relay])[0] || ""),
        );
        if (communityRelays.size > 0 && !acceptedByCommunity) {
          throw new Error("no community relay accepted the event");
        }
      });
    mirrorPromises.set(event.id, promise);

    try {
      await promise;
    } catch (error) {
      mirrorPromises.delete(event.id);
      throw error;
    }
  }

  function syncStreamSubscriptions(nextStreams: CommunityStream[]) {
    const activeAddresses = new Set(
      nextStreams
        .filter(
          (stream) => stream.status === "live" || stream.status === "planned",
        )
        .map((stream) => stream.address),
    );
    for (const [address, subscription] of streamSubscriptions) {
      if (!activeAddresses.has(address)) {
        subscription.close();
        streamSubscriptions.delete(address);
      }
    }
    for (const stream of nextStreams) {
      if (
        !activeAddresses.has(stream.address) ||
        streamSubscriptions.has(stream.address)
      )
        continue;
      const filter = {
        kinds: [LIVE_STREAM_KIND],
        authors: [stream.event.pubkey],
        "#d": [stream.identifier],
        since: stream.event.created_at,
      };
      const subscription = pool.subscribeMany(
        normalizeRelays([...configuredPublicRelays, ...stream.relays]),
        filter,
        {
          onevent: (event) => {
            if (
              !verifyEvent(event) ||
              !hasCommunityTag(event, communityContext?.pubkey || "")
            )
              return;
            void mirrorEvent(event).then(() => void loadStreams());
          },
        },
      );
      streamSubscriptions.set(stream.address, subscription);
    }
  }

  function closeStreamSubscriptions() {
    for (const subscription of streamSubscriptions.values())
      subscription.close();
    streamSubscriptions.clear();
  }

  function closeLaunchSubscription() {
    launchSubscription?.close();
    launchSubscription = null;
  }

  function joinStream(stream: CommunityStream) {
    if (!stream.playbackUrl && !stream.recordingUrl) return;
    joinedAddress = stream.address;
    void startChat(stream);
    scheduleHostResize();
  }

  function leaveStream() {
    joinedAddress = "";
    stopChat();
    scheduleHostResize();
  }

  function chatRelaysFor(stream: CommunityStream) {
    return normalizeRelays([
      ...(communityContext?.relays || []),
      ...configuredPublicRelays,
      ...stream.relays,
    ]);
  }

  function profileRelaysFor(stream: CommunityStream) {
    return normalizeRelays([
      ...configuredPublicRelays,
      ...(initPayload?.relays || []),
      ...stream.relays,
    ]);
  }

  async function startChat(stream: CommunityStream) {
    stopChat();
    const session = ++chatSession;
    const relays = chatRelaysFor(stream);
    chatLoading = true;
    chatError = "";
    const filter = {
      kinds: [LIVE_CHAT_KIND],
      "#a": [stream.address],
      limit: CHAT_LIMIT,
    };
    try {
      const existing = await pool.querySync(relays, filter, { maxWait: 4000 });
      if (session !== chatSession) return;
      chatMessages = existing.filter(
        (event) =>
          verifyEvent(event) && referencesStream(event, stream.address),
      );
      sortChatMessages();
      scrollChatToBottom();
      void loadChatProfiles(
        [
          ...chatMessages.map((message) => message.pubkey),
          communityContext?.viewer.pubkey || "",
        ],
        profileRelaysFor(stream),
        session,
      );
      chatSubscription = pool.subscribeMany(
        relays,
        {
          kinds: [LIVE_CHAT_KIND],
          "#a": [stream.address],
          since: Math.floor(Date.now() / 1000) - 5,
        },
        { onevent: (event) => addChatMessage(event, stream.address) },
      );
    } catch (error) {
      if (session === chatSession)
        chatError = error instanceof Error ? error.message : String(error);
    } finally {
      if (session === chatSession) chatLoading = false;
    }
  }

  function referencesStream(event: Event, address: string) {
    return (
      event.kind === LIVE_CHAT_KIND &&
      event.tags.some((tag) => tag[0] === "a" && tag[1] === address)
    );
  }

  function addChatMessage(event: Event, address: string) {
    if (!verifyEvent(event) || !referencesStream(event, address)) return;
    if (chatMessages.some((message) => message.id === event.id)) return;
    chatMessages = [...chatMessages, event];
    sortChatMessages();
    scrollChatToBottom();
    if (selectedStream) {
      void loadChatProfiles(
        [event.pubkey],
        profileRelaysFor(selectedStream),
        chatSession,
      );
    }
  }

  function sortChatMessages() {
    chatMessages = [...chatMessages]
      .sort(
        (left, right) =>
          left.created_at - right.created_at || left.id.localeCompare(right.id),
      )
      .slice(-CHAT_LIMIT);
  }

  async function loadChatProfiles(
    pubkeys: string[],
    relays: string[],
    session: number,
  ) {
    const pending = Array.from(new Set(pubkeys.filter(Boolean))).filter(
      (pubkey) => !chatProfiles[pubkey] && !requestedChatProfiles.has(pubkey),
    );
    if (!pending.length || !relays.length) return;
    pending.forEach((pubkey) => requestedChatProfiles.add(pubkey));

    try {
      const events = await pool.querySync(
        relays,
        { kinds: [0], authors: pending, limit: pending.length * 3 },
        { maxWait: 4000 },
      );
      if (session !== chatSession) {
        pending.forEach((pubkey) => requestedChatProfiles.delete(pubkey));
        return;
      }
      const latest = new Map<string, Event>();
      for (const event of events) {
        if (!verifyEvent(event) || event.kind !== 0) continue;
        const current = latest.get(event.pubkey);
        if (!current || event.created_at > current.created_at) {
          latest.set(event.pubkey, event);
        }
      }
      const profiles: Record<string, ChatProfile> = {};
      for (const [pubkey, event] of latest) {
        const profile = parseChatProfile(event.content);
        if (profile) profiles[pubkey] = profile;
      }
      if (Object.keys(profiles).length) {
        chatProfiles = { ...chatProfiles, ...profiles };
      }
    } catch {
      pending.forEach((pubkey) => requestedChatProfiles.delete(pubkey));
    }
  }

  function parseChatProfile(content: string): ChatProfile | null {
    try {
      const metadata = JSON.parse(content) as Record<string, unknown>;
      const rawName = [
        metadata.display_name,
        metadata.displayName,
        metadata.name,
      ].find(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim()),
      );
      const name = rawName?.trim();
      let picture: string | undefined;
      if (typeof metadata.picture === "string") {
        try {
          const url = new URL(metadata.picture);
          if (url.protocol === "https:") picture = url.toString();
        } catch {
          // Keep valid profile names when the image URL is malformed.
        }
      }
      return name || picture ? { name, picture } : null;
    } catch {
      return null;
    }
  }

  function chatDisplayName(pubkey: string) {
    const name = chatProfiles[pubkey]?.name;
    if (pubkey === communityContext?.viewer.pubkey) {
      return name ? `${name} · You` : "You";
    }
    return name || shortPubkey(pubkey);
  }

  function chatInitial(pubkey: string) {
    return (chatProfiles[pubkey]?.name || pubkey).trim().slice(0, 1).toUpperCase();
  }

  function avatarHue(pubkey: string) {
    return (
      Array.from(pubkey).reduce(
        (total, character) => total + character.charCodeAt(0),
        0,
      ) % 360
    );
  }

  function scrollChatToBottom() {
    requestAnimationFrame(() => {
      messagesElement?.scrollTo({ top: messagesElement.scrollHeight });
    });
  }

  function stopChat() {
    chatSession += 1;
    chatSubscription?.close();
    chatSubscription = null;
    chatMessages = [];
    chatText = "";
    chatLoading = false;
    chatSending = false;
    chatError = "";
  }

  async function sendChat() {
    if (
      !bridge ||
      !selectedStream ||
      !communityContext?.viewer.pubkey ||
      chatSending
    )
      return;
    const content = chatText.trim().slice(0, 500);
    if (!content) return;
    const session = chatSession;
    const viewerPubkey = communityContext.viewer.pubkey;
    const relays = chatRelaysFor(selectedStream);
    const template: EventTemplate = {
      kind: LIVE_CHAT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [["a", selectedStream.address, relays[0] || ""]],
    };
    const optimisticId = `pending:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const optimisticMessage = {
      ...template,
      id: optimisticId,
      pubkey: viewerPubkey,
      sig: "",
      delivery: "sending",
    } as ChatMessage;
    chatSending = true;
    chatError = "";
    chatText = "";
    chatMessages = [...chatMessages, optimisticMessage];
    sortChatMessages();
    scrollChatToBottom();
    let signedEvent: Event | null = null;
    try {
      const signResponse = (await bridge.request(
        "nostr:sign",
        template,
      )) as NostrSignResponse;
      if ("error" in signResponse) throw new Error(signResponse.error);
      signedEvent = signResponse.event as Event;
      if (!verifyEvent(signedEvent)) {
        throw new Error("The signer returned an invalid event");
      }
      if (session !== chatSession) return;
      chatMessages = chatMessages.map((message) =>
        message.id === optimisticId
          ? { ...signedEvent!, delivery: "sending" }
          : message,
      );

      const response = (await bridge.request("nostr:publish", {
        event: signedEvent,
        relays,
      })) as NostrPublishResponse;
      if ("error" in response) throw new Error(response.error);
      const result = response.result as PublishResult | undefined;
      if (result?.successCount === 0) {
        throw new Error("No relay accepted the message");
      }
      if (session !== chatSession) return;
      chatMessages = chatMessages.map((message) => {
        if (message.id !== signedEvent?.id) return message;
        const { delivery: _delivery, ...delivered } = message;
        return delivered as ChatMessage;
      });
    } catch (error) {
      if (session === chatSession) {
        chatMessages = chatMessages.filter(
          (message) =>
            message.id !== optimisticId && message.id !== signedEvent?.id,
        );
        if (!chatText) chatText = content;
        chatError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (session === chatSession) chatSending = false;
    }
  }

  async function shareStream(stream: CommunityStream) {
    const relays = normalizeRelays([
      ...(communityContext?.relays || []),
      ...configuredPublicRelays,
    ]);
    const naddr = streamNaddr(stream, relays);
    await copyValue(`https://zap.stream/${naddr}`, "Stream link");
  }

  function formatDate(seconds?: number) {
    if (!seconds) return "";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(seconds * 1000));
  }

  function shortPubkey(pubkey: string) {
    return pubkey ? `${pubkey.slice(0, 8)}…${pubkey.slice(-5)}` : "unknown";
  }

  function streamStatusText(stream: CommunityStream) {
    if (stream.status === "live")
      return stream.playbackUrl ? "Live now" : "Connecting";
    if (stream.status === "planned")
      return stream.starts ? `Starts ${formatDate(stream.starts)}` : "Planned";
    return stream.recordingUrl ? "Replay available" : "Ended";
  }

  function getContentHeight() {
    return Math.ceil(
      Math.max(
        mainElement?.scrollHeight || 0,
        mainElement?.getBoundingClientRect().height || 0,
        MIN_COLLAPSED_HEIGHT,
      ) + 2,
    );
  }

  function requestHostResize() {
    if (!bridge) return;
    const height = getContentHeight();
    if (!Number.isFinite(height) || Math.abs(height - lastRequestedHeight) < 2)
      return;
    lastRequestedHeight = height;
    void bridge.request("ui:resize", { height }).catch(() => {});
  }

  function scheduleHostResize() {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        requestHostResize();
      });
    });
  }

  function retryLoads() {
    if (!communityContext) return;
    void refreshCapabilities(communityContext);
    void loadStreams(communityContext);
  }

  function retryVisibleLoads() {
    if (document.visibilityState === "visible") retryLoads();
  }

  $effect(() => {
    const element = mainElement;
    if (!bridge || !element) return;
    scheduleHostResize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scheduleHostResize);
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    const ctx = communityContext;
    if (!bridge || !ctx) return;
    const interval = window.setInterval(
      () => {
        if (document.visibilityState === "visible") void loadStreams(ctx);
      },
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  });

  $effect(() => {
    window.addEventListener("pageshow", retryLoads);
    window.addEventListener("focus", retryLoads);
    window.addEventListener("online", retryLoads);
    document.addEventListener("visibilitychange", retryVisibleLoads);
    return () => {
      window.removeEventListener("pageshow", retryLoads);
      window.removeEventListener("focus", retryLoads);
      window.removeEventListener("online", retryLoads);
      document.removeEventListener("visibilitychange", retryVisibleLoads);
    };
  });

  $effect(() => {
    streams;
    expanded;
    joinedAddress;
    setupOpen;
    providerLoading;
    prepared;
    chatMessages;
    scheduleHostResize();
  });

  $effect(() => {
    const instance = createWidgetBridge({
      targetWindow: window.parent,
      targetOrigin: "*",
      timeoutMs: 20_000,
    });
    bridge = instance;
    const offInit = instance.onEvent("widget:init", (payload) => {
      initPayload = payload;
      applyTheme(payload.theme, payload.themeBackground);
      applyCommunityContext(payload.communityContext ?? null);
      void refreshCapabilities(payload.communityContext ?? null);
      void loadStreams(payload.communityContext ?? null);
    });
    const offContext = instance.onEvent(
      "community:contextChanged",
      (payload) => {
        applyCommunityContext(payload.communityContext ?? null);
        void refreshCapabilities(payload.communityContext ?? null);
        void loadStreams(payload.communityContext ?? null);
      },
    );
    const offTheme = instance.onEvent("widget:themeChanged", (payload) => {
      applyTheme(payload.theme, payload.themeBackground);
    });
    instance.signalReady();

    return () => {
      offInit();
      offContext();
      offTheme();
      closeLaunchSubscription();
      closeStreamSubscriptions();
      stopChat();
      pool.destroy();
      instance.destroy();
      bridge = null;
    };
  });
</script>

<main bind:this={mainElement}>
  <section class="shell">
    <header class="masthead" class:compacted={!expanded}>
      <div class="signal" aria-hidden="true"><span></span><i></i><b></b></div>
      <div class="masthead-copy">
        <p class="eyebrow">Community broadcast</p>
        <h2>{getCommunityName()}</h2>
        <p>
          {#if liveStreams.length}
            {liveStreams.length} live {liveStreams.length === 1
              ? "stream"
              : "streams"}
          {:else if plannedStreams.length}
            {plannedStreams.length} upcoming {plannedStreams.length === 1
              ? "stream"
              : "streams"}
          {:else if loadError}
            Unable to check broadcasts
          {:else if !hasLoadedStreams || loadingStreams}
            Checking for broadcasts
          {:else}
            The community stream is offline
          {/if}
        </p>
      </div>
      <div class="masthead-actions">
        <button
          class="icon-button refresh-action"
          onclick={() => void loadStreams()}
          disabled={loadingStreams}
          title="Refresh streams"
        >
          <span class:spin={loadingStreams}>↻</span>
        </button>
        {#if canModerate}
          <button class="primary compact studio-action" onclick={openSetup}
            >Start a stream</button
          >
        {/if}
        <button
          class="accordion-toggle"
          class:expanded
          onclick={toggleExpanded}
          aria-expanded={expanded}
          aria-controls="community-stream-panel"
        >
          <span>{expanded ? "Collapse" : "Expand"}</span>
          <b aria-hidden="true">⌄</b>
        </button>
      </div>
    </header>

    {#if expanded}
      <div id="community-stream-panel" class="accordion-panel">
        {#if !communityContext}
          <div class="notice">Waiting for BudaBit community context…</div>
        {:else}
          {#if loadError}<div class="notice error" role="alert">
              {loadError}
            </div>{/if}

          {#if setupOpen && canModerate}
        <section class="setup" aria-labelledby="setup-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Moderator studio</p>
              <h3 id="setup-title">Prepare an OBS broadcast</h3>
            </div>
            <button class="text-button" onclick={closeSetup}>Close</button>
          </div>

          {#if !providerAccount}
            <div class="provider-connect">
              <label>
                <span>Streaming provider</span>
                <input
                  bind:value={providerUrl}
                  placeholder="https://api-core.zap.stream/api/v1"
                />
              </label>
              <button
                class="primary"
                onclick={() => void connectProvider()}
                disabled={providerLoading || !initPayload?.pubkey}
              >
                {providerLoading ? "Connecting…" : "Connect with Nostr"}
              </button>
              <p class="help">
                Your BudaBit signer authorizes the provider. The widget never
                sees your private key.
              </p>
            </div>
          {:else}
            <div class="provider-summary">
              <span>Provider connected</span>
              <strong>{providerAccount.balance.toLocaleString()} sats</strong>
              <button
                class="text-button"
                onclick={() => {
                  providerAccount = null;
                  providerClient = null;
                  prepared = false;
                }}>Change</button
              >
            </div>

            {#if providerAccount.tos?.accepted === false && !termsAccepted}
              <div class="terms">
                <p>
                  This provider requires its terms to be accepted before
                  streaming.
                </p>
                <a
                  href={providerAccount.tos.link}
                  target="_blank"
                  rel="noreferrer">Read provider terms</a
                >
                <button
                  class="secondary"
                  onclick={() => void acceptProviderTerms()}
                  disabled={providerLoading}
                >
                  Accept and continue
                </button>
              </div>
            {:else}
              <div class="form-grid">
                <label class="wide">
                  <span>Stream title</span>
                  <input bind:value={streamTitle} maxlength="120" />
                </label>
                <label class="wide">
                  <span>Summary</span>
                  <textarea bind:value={streamSummary} rows="3" maxlength="500"
                  ></textarea>
                </label>
                <label>
                  <span>Cover image URL</span>
                  <input
                    bind:value={streamImage}
                    type="url"
                    placeholder="https://…"
                  />
                </label>
                <label>
                  <span>Additional tags</span>
                  <input bind:value={streamTags} placeholder="music, meetup" />
                </label>
                <label>
                  <span>OBS ingest endpoint</span>
                  <select bind:value={selectedEndpointName}>
                    {#each providerAccount.endpoints as endpoint}
                      <option value={endpoint.name}
                        >{endpoint.name} · {endpoint.cost.rate}
                        {endpoint.cost.unit}</option
                      >
                    {/each}
                  </select>
                </label>
                <label class="wide">
                  <span>Public announcement relays</span>
                  <textarea bind:value={publicRelayInput} rows="2"></textarea>
                  <small
                    >The signed stream is also copied to this community’s
                    relays.</small
                  >
                </label>
              </div>

              <button
                class="primary"
                onclick={() => void prepareStream()}
                disabled={preparing || !selectedEndpoint}
              >
                {preparing
                  ? "Preparing…"
                  : prepared
                    ? "Update stream details"
                    : "Prepare stream"}
              </button>

              {#if prepared && selectedEndpoint}
                <div class="obs-card">
                  <div>
                    <p class="eyebrow">OBS settings</p>
                    <h4>Start streaming when you are ready</h4>
                    <p>{launchStatus}</p>
                  </div>
                  <div class="credential">
                    <span>Server URL</span>
                    <code>{selectedEndpoint.url}</code>
                    <button
                      onclick={() =>
                        void copyValue(selectedEndpoint.url, "Server URL")}
                      >Copy</button
                    >
                  </div>
                  <div class="credential secret">
                    <span>Stream key</span>
                    <code>••••••••••••••••••••</code>
                    <button
                      onclick={() =>
                        void copyValue(selectedEndpoint.key, "Stream key")}
                      >Copy key</button
                    >
                  </div>
                  <p class="warning">
                    Treat the stream key like a password. Stop the broadcast
                    from OBS when the event ends.
                  </p>
                </div>
              {/if}
            {/if}
          {/if}
          {#if providerError}<div class="notice error" role="alert">
              {providerError}
            </div>{/if}
        </section>
          {/if}

          {#if selectedStream && joinedAddress}
        <section class="stage">
          <div class="stage-heading">
            <div>
              <span
                class:live-pill={selectedStream.status === "live"}
                class="status-pill"
              >
                {streamStatusText(selectedStream)}
              </span>
              <h3>{selectedStream.title}</h3>
            </div>
            <button class="secondary compact" onclick={leaveStream}
              >Leave stream</button
            >
          </div>
          <div class="watch-grid">
            <div>
              <HlsPlayer
                src={selectedStream.playbackUrl || selectedStream.recordingUrl}
                poster={selectedStream.thumbnail || selectedStream.image}
                title={selectedStream.title}
              />
              {#if selectedStream.summary}<p class="stream-summary">
                  {selectedStream.summary}
                </p>{/if}
            </div>
            <aside class="chat" aria-label="Live chat">
              <div class="chat-heading">
                <strong>Live chat</strong>
                <span>{chatMessages.length}</span>
              </div>
              <div
                class="messages"
                aria-live="polite"
                bind:this={messagesElement}
              >
                {#if chatLoading}<p class="empty-chat">
                    Loading conversation…
                  </p>{/if}
                {#each chatMessages as message (message.id)}
                  <article
                    class:self={message.pubkey ===
                      communityContext.viewer.pubkey}
                    class:pending={message.delivery === "sending"}
                  >
                    <div
                      class="chat-avatar"
                      style={`--avatar-hue: ${avatarHue(message.pubkey)}deg`}
                    >
                      <span>{chatInitial(message.pubkey)}</span>
                      {#if chatProfiles[message.pubkey]?.picture}
                        <img
                          src={chatProfiles[message.pubkey].picture}
                          alt=""
                          loading="lazy"
                          referrerpolicy="no-referrer"
                          onerror={(event) => event.currentTarget.remove()}
                        />
                      {/if}
                    </div>
                    <div class="chat-message">
                      <div class="chat-byline">
                        <strong>{chatDisplayName(message.pubkey)}</strong>
                        <time
                          >{new Date(
                            message.created_at * 1000,
                          ).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}</time
                        >
                      </div>
                      <p>{message.content}</p>
                      {#if message.delivery === "sending"}
                        <small>Sending…</small>
                      {/if}
                    </div>
                  </article>
                {/each}
                {#if !chatLoading && !chatMessages.length}<p class="empty-chat">
                    No messages yet. Say hello.
                  </p>{/if}
              </div>
              <form
                onsubmit={(event) => {
                  event.preventDefault();
                  void sendChat();
                }}
              >
                <input
                  bind:value={chatText}
                  maxlength="500"
                  placeholder={communityContext.viewer.pubkey
                    ? "Write to the live chat"
                    : "Log in to chat"}
                  disabled={!communityContext.viewer.pubkey}
                />
                <button
                  class="primary compact"
                  disabled={!chatText.trim() ||
                    !communityContext.viewer.pubkey ||
                    chatSending}>Send</button
                >
              </form>
              {#if chatError}<p class="chat-error">{chatError}</p>{/if}
            </aside>
          </div>
        </section>
          {/if}

          {#if liveStreams.length || plannedStreams.length || recentStreams.length}
        <div class="stream-list">
          {#each [...liveStreams, ...plannedStreams, ...recentStreams] as stream (stream.address)}
            <article
              class="stream-card"
              class:is-live={stream.status === "live"}
            >
              <div
                class="poster"
                style:background-image={stream.thumbnail || stream.image
                  ? `url("${stream.thumbnail || stream.image}")`
                  : undefined}
              >
                <span
                  class:live-pill={stream.status === "live"}
                  class="status-pill">{streamStatusText(stream)}</span
                >
              </div>
              <div class="stream-copy">
                <h3>{stream.title}</h3>
                <p>
                  {stream.summary || `Hosted by ${shortPubkey(stream.host)}`}
                </p>
                <div class="meta">
                  <span>{shortPubkey(stream.host)}</span>
                  {#if stream.participants !== undefined}<span
                      >{stream.participants} watching</span
                    >{/if}
                  {#if stream.starts}<span>{formatDate(stream.starts)}</span
                    >{/if}
                </div>
              </div>
              <div class="stream-actions">
                {#if stream.playbackUrl || stream.recordingUrl}
                  <button
                    class="primary compact"
                    onclick={() => joinStream(stream)}
                  >
                    {stream.status === "live" ? "Join stream" : "Watch replay"}
                  </button>
                {/if}
                <button
                  class="secondary compact"
                  onclick={() => void shareStream(stream)}>Share</button
                >
              </div>
            </article>
          {/each}
        </div>
          {:else}
        <div class="offline">
          <div class="offline-orbit"><span></span></div>
          <div>
            <strong
              >{loadError
                ? "Broadcast status unavailable"
                : hasLoadedStreams
                  ? "No broadcast is live"
                  : "Checking for broadcasts"}</strong
            >
            <p>
              {hasLoadedStreams
                ? "When a moderator starts streaming, the player and community chat will appear here."
                : "The current community view will stay in place while updates are checked."}
            </p>
          </div>
          {#if canModerate}<button class="secondary compact" onclick={openSetup}
              >Open studio</button
            >{/if}
        </div>
          {/if}
        {/if}
      </div>
    {/if}
  </section>
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }
  :global(html) {
    color-scheme: light;
    background: var(--host-background, transparent);
    font-family:
      Inter,
      ui-sans-serif,
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
  }
  :global(html[data-theme="dark"]) {
    color-scheme: dark;
  }
  :global(body) {
    margin: 0;
    background: transparent;
    color: #172033;
  }
  :global(button),
  :global(input),
  :global(textarea),
  :global(select) {
    font: inherit;
  }
  main {
    width: 100%;
    padding: 0.1rem;
  }
  .shell {
    overflow: hidden;
    border: 1px solid rgb(148 163 184 / 0.3);
    border-radius: 24px;
    background: linear-gradient(
      145deg,
      rgb(255 255 255 / 0.96),
      rgb(248 250 252 / 0.92)
    );
    box-shadow: 0 18px 60px rgb(15 23 42 / 0.08);
  }
  .masthead {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
    min-height: 132px;
    padding: 1.45rem 1.6rem;
    color: #fff;
    background:
      radial-gradient(
        circle at 12% 10%,
        rgb(251 113 133 / 0.45),
        transparent 28%
      ),
      linear-gradient(118deg, #111827 0%, #1f2937 58%, #4c0519 130%);
  }
  .masthead.compacted {
    min-height: 72px;
    padding: 0.7rem 1rem;
    gap: 0.75rem;
  }
  .masthead.compacted .signal {
    width: 46px;
    height: 46px;
  }
  .masthead.compacted .signal span {
    width: 15px;
    height: 15px;
    box-shadow: 0 0 16px #fb7185;
  }
  .masthead.compacted .signal i {
    inset: 10px;
  }
  .masthead.compacted .signal b {
    inset: 2px;
  }
  .masthead.compacted .eyebrow,
  .masthead.compacted .refresh-action,
  .masthead.compacted .studio-action {
    display: none;
  }
  .masthead.compacted h2 {
    font-size: 1.1rem;
  }
  .masthead.compacted .masthead-copy > p:last-child {
    margin-top: 0.15rem;
    font-size: 0.78rem;
  }
  .signal {
    position: relative;
    display: grid;
    place-items: center;
    width: 74px;
    height: 74px;
  }
  .signal span {
    width: 21px;
    height: 21px;
    border-radius: 50%;
    background: #fb7185;
    box-shadow: 0 0 24px #fb7185;
  }
  .signal i,
  .signal b {
    position: absolute;
    border: 2px solid #fda4af;
    border-block-color: transparent;
    border-radius: 50%;
  }
  .signal i {
    inset: 14px;
  }
  .signal b {
    inset: 2px;
    opacity: 0.45;
  }
  .eyebrow {
    margin: 0 0 0.28rem;
    color: #fb7185;
    font-size: 0.69rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .masthead h2,
  .section-heading h3,
  .stage h3 {
    margin: 0;
  }
  .masthead h2 {
    font-size: clamp(1.35rem, 3vw, 2rem);
    letter-spacing: -0.03em;
  }
  .masthead-copy > p:last-child {
    margin: 0.38rem 0 0;
    color: #cbd5e1;
    font-size: 0.9rem;
  }
  .masthead-actions,
  .stream-actions {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }
  button {
    border: 0;
    cursor: pointer;
    transition:
      transform 140ms ease,
      background 140ms ease,
      opacity 140ms ease;
  }
  button:hover:not(:disabled) {
    transform: translateY(-1px);
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .primary,
  .secondary,
  .text-button,
  .icon-button,
  .accordion-toggle {
    border-radius: 11px;
    font-weight: 750;
  }
  .primary {
    padding: 0.76rem 1rem;
    color: white;
    background: #e11d48;
    box-shadow: 0 8px 20px rgb(225 29 72 / 0.22);
  }
  .primary:hover:not(:disabled) {
    background: #be123c;
  }
  .secondary {
    padding: 0.72rem 0.95rem;
    color: #334155;
    background: #e2e8f0;
  }
  .text-button {
    padding: 0.45rem 0.6rem;
    color: #be123c;
    background: transparent;
  }
  .compact {
    padding: 0.58rem 0.78rem;
    font-size: 0.82rem;
  }
  .icon-button {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    color: #e2e8f0;
    background: rgb(255 255 255 / 0.11);
    font-size: 1.25rem;
  }
  .accordion-toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 38px;
    padding: 0.55rem 0.72rem;
    color: #f8fafc;
    background: rgb(255 255 255 / 0.11);
    font-size: 0.76rem;
  }
  .accordion-toggle b {
    display: inline-block;
    font-size: 1.05rem;
    line-height: 1;
    transition: transform 160ms ease;
  }
  .accordion-toggle.expanded b {
    transform: rotate(180deg);
  }
  .spin {
    display: inline-block;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .notice {
    margin: 1rem;
    border-radius: 12px;
    padding: 0.8rem 1rem;
    color: #475569;
    background: #f1f5f9;
  }
  .notice.error {
    color: #9f1239;
    background: #fff1f2;
  }
  .setup,
  .stage {
    margin: 1rem;
    border: 1px solid #e2e8f0;
    border-radius: 18px;
    padding: 1.2rem;
    background: rgb(255 255 255 / 0.78);
  }
  .section-heading,
  .stage-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .provider-connect {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 0.75rem;
  }
  .provider-connect .help {
    grid-column: 1 / -1;
    margin: 0;
    color: #64748b;
    font-size: 0.8rem;
  }
  label {
    display: grid;
    gap: 0.38rem;
    color: #475569;
    font-size: 0.77rem;
    font-weight: 750;
  }
  input,
  textarea,
  select {
    width: 100%;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    padding: 0.72rem 0.8rem;
    color: #172033;
    background: #fff;
    outline: none;
  }
  input:focus,
  textarea:focus,
  select:focus {
    border-color: #fb7185;
    box-shadow: 0 0 0 3px rgb(251 113 133 / 0.18);
  }
  textarea {
    resize: vertical;
  }
  label small {
    color: #64748b;
    font-weight: 500;
  }
  .provider-summary {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 1rem;
    border-radius: 12px;
    padding: 0.72rem 0.85rem;
    background: #f1f5f9;
  }
  .provider-summary strong {
    margin-left: auto;
  }
  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.85rem;
    margin-bottom: 1rem;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .terms {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    border-radius: 12px;
    padding: 1rem;
    background: #fff7ed;
  }
  .terms p {
    flex: 1 1 100%;
    margin: 0;
  }
  .terms a {
    color: #be123c;
    font-weight: 700;
  }
  .obs-card {
    display: grid;
    gap: 0.8rem;
    margin-top: 1rem;
    border: 1px solid #fecdd3;
    border-radius: 16px;
    padding: 1rem;
    background: linear-gradient(135deg, #fff1f2, #fff);
  }
  .obs-card h4,
  .obs-card p {
    margin: 0.2rem 0 0;
  }
  .credential {
    display: grid;
    grid-template-columns: 6.5rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.6rem;
    border-radius: 10px;
    padding: 0.6rem;
    background: #fff;
  }
  .credential span {
    color: #64748b;
    font-size: 0.72rem;
    font-weight: 750;
    text-transform: uppercase;
  }
  .credential code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .credential button {
    border-radius: 8px;
    padding: 0.48rem 0.65rem;
    color: #fff;
    background: #334155;
  }
  .warning {
    color: #9f1239;
    font-size: 0.78rem;
  }
  .stage-heading {
    align-items: center;
  }
  .stage-heading .status-pill {
    display: inline-block;
    margin-bottom: 0.35rem;
  }
  .watch-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(260px, 0.7fr);
    gap: 1rem;
  }
  .stream-summary {
    margin: 0.8rem 0 0;
    color: #475569;
    line-height: 1.5;
  }
  .chat {
    display: grid;
    grid-template-rows: auto minmax(250px, 1fr) auto auto;
    overflow: hidden;
    min-height: 360px;
    max-height: 560px;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    background: #f8fafc;
  }
  .chat-heading {
    display: flex;
    justify-content: space-between;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid #e2e8f0;
  }
  .chat-heading span {
    display: grid;
    place-items: center;
    min-width: 24px;
    height: 24px;
    border-radius: 999px;
    color: #be123c;
    background: #ffe4e6;
    font-size: 0.72rem;
    font-weight: 800;
  }
  .messages {
    overflow-y: auto;
    padding: 0.75rem;
  }
  .messages article {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    align-items: start;
    gap: 0.65rem;
    margin-bottom: 0.45rem;
    border-radius: 12px;
    padding: 0.65rem;
    background: #fff;
    transition: opacity 140ms ease;
  }
  .messages article.self {
    background: #fff1f2;
  }
  .messages article.pending {
    opacity: 0.72;
  }
  .chat-avatar {
    position: relative;
    display: grid;
    place-items: center;
    overflow: hidden;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: #fff;
    background: hsl(var(--avatar-hue) 52% 42%);
    font-size: 0.72rem;
    font-weight: 850;
  }
  .chat-avatar img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .chat-message {
    min-width: 0;
  }
  .chat-byline {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .chat-byline strong {
    overflow: hidden;
    color: #64748b;
    font-size: 0.72rem;
    font-weight: 800;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat-message p {
    margin: 0.16rem 0 0;
    overflow-wrap: anywhere;
    font-size: 0.86rem;
    line-height: 1.4;
  }
  .chat-byline time,
  .chat-message small {
    color: #94a3b8;
    font-size: 0.64rem;
  }
  .chat-message small {
    display: block;
    margin-top: 0.2rem;
  }
  .empty-chat {
    color: #64748b;
    font-size: 0.82rem;
    text-align: center;
  }
  .chat form {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.45rem;
    padding: 0.65rem;
    border-top: 1px solid #e2e8f0;
  }
  .chat form input {
    min-width: 0;
    padding: 0.58rem 0.65rem;
  }
  .chat-error {
    margin: 0;
    padding: 0 0.7rem 0.6rem;
    color: #be123c;
    font-size: 0.72rem;
  }
  .stream-list {
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
  }
  .stream-card {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
    overflow: hidden;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    background: rgb(255 255 255 / 0.78);
  }
  .stream-card.is-live {
    border-color: #fda4af;
    box-shadow: 0 8px 25px rgb(190 18 60 / 0.08);
  }
  .poster {
    display: flex;
    align-items: flex-start;
    min-height: 112px;
    padding: 0.65rem;
    background-color: #1f2937;
    background-position: center;
    background-size: cover;
  }
  .status-pill {
    border-radius: 999px;
    padding: 0.32rem 0.55rem;
    color: #475569;
    background: rgb(255 255 255 / 0.88);
    font-size: 0.66rem;
    font-weight: 850;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .status-pill.live-pill {
    color: #fff;
    background: #e11d48;
    box-shadow: 0 0 0 4px rgb(225 29 72 / 0.16);
  }
  .stream-copy {
    min-width: 0;
    padding-block: 0.8rem;
  }
  .stream-copy h3 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
  }
  .stream-copy > p {
    display: -webkit-box;
    overflow: hidden;
    margin: 0.35rem 0;
    color: #64748b;
    font-size: 0.82rem;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    color: #94a3b8;
    font-size: 0.7rem;
  }
  .stream-actions {
    padding-right: 1rem;
  }
  .offline {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 1rem;
    min-height: 110px;
    padding: 1rem 1.4rem;
  }
  .offline p {
    margin: 0.28rem 0 0;
    color: #64748b;
    font-size: 0.83rem;
  }
  .offline-orbit {
    display: grid;
    place-items: center;
    width: 50px;
    height: 50px;
    border: 1px dashed #94a3b8;
    border-radius: 50%;
  }
  .offline-orbit span {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #94a3b8;
  }

  :global(html[data-theme="dark"] body) {
    color: #e5e7eb;
  }
  :global(html[data-theme="dark"]) .shell {
    border-color: rgb(71 85 105 / 0.75);
    background: linear-gradient(
      145deg,
      rgb(15 23 42 / 0.96),
      rgb(17 24 39 / 0.95)
    );
    box-shadow: none;
  }
  :global(html[data-theme="dark"]) .setup,
  :global(html[data-theme="dark"]) .stage,
  :global(html[data-theme="dark"]) .stream-card {
    border-color: #334155;
    background: rgb(30 41 59 / 0.78);
  }
  :global(html[data-theme="dark"]) input,
  :global(html[data-theme="dark"]) textarea,
  :global(html[data-theme="dark"]) select,
  :global(html[data-theme="dark"]) .credential,
  :global(html[data-theme="dark"]) .messages article {
    border-color: #475569;
    color: #e5e7eb;
    background: #111827;
  }
  :global(html[data-theme="dark"]) .provider-summary,
  :global(html[data-theme="dark"]) .chat {
    border-color: #334155;
    color: #e5e7eb;
    background: #0f172a;
  }
  :global(html[data-theme="dark"]) .obs-card {
    border-color: #881337;
    background: linear-gradient(135deg, #4c0519, #111827);
  }
  :global(html[data-theme="dark"]) .stream-copy > p,
  :global(html[data-theme="dark"]) .stream-summary,
  :global(html[data-theme="dark"]) label {
    color: #cbd5e1;
  }

  @media (max-width: 760px) {
    .masthead {
      grid-template-columns: auto 1fr;
      padding: 1.1rem;
    }
    .signal {
      width: 52px;
      height: 52px;
    }
    .masthead-actions {
      grid-column: 1 / -1;
      justify-content: flex-end;
    }
    .masthead.compacted {
      grid-template-columns: auto minmax(0, 1fr) auto;
      padding: 0.65rem 0.8rem;
    }
    .masthead.compacted .masthead-actions {
      grid-column: auto;
    }
    .watch-grid {
      grid-template-columns: 1fr;
    }
    .chat {
      min-height: 340px;
      max-height: 480px;
    }
    .stream-card {
      grid-template-columns: 105px minmax(0, 1fr);
    }
    .poster {
      min-height: 110px;
    }
    .stream-actions {
      grid-column: 1 / -1;
      justify-content: flex-end;
      padding: 0 0.8rem 0.8rem;
    }
    .form-grid,
    .provider-connect {
      grid-template-columns: 1fr;
    }
    .wide,
    .provider-connect .help {
      grid-column: auto;
    }
    .credential {
      grid-template-columns: 1fr auto;
    }
    .credential span {
      grid-column: 1 / -1;
    }
    .offline {
      grid-template-columns: auto 1fr;
    }
    .offline button {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 480px) {
    .shell {
      border-radius: 18px;
    }
    .masthead h2 {
      font-size: 1.25rem;
    }
    .masthead.compacted .accordion-toggle span {
      position: absolute;
      overflow: hidden;
      width: 1px;
      height: 1px;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    .setup,
    .stage {
      margin: 0.7rem;
      padding: 0.85rem;
    }
    .stream-list {
      padding: 0.7rem;
    }
    .stream-card {
      grid-template-columns: 1fr;
    }
    .poster {
      min-height: 155px;
    }
    .stream-copy {
      padding: 0 0.8rem;
    }
  }
</style>
