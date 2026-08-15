# BudaBit Community Stream

Streaming widget extension for BudaBit communities. Moderators prepare an OBS broadcast through a zap.stream-compatible provider; members watch HLS video and participate in NIP-53 live chat directly from the community home page.

## Current Scope

- Hosted `https://api-core.zap.stream/api/v1` provider by default
- Custom zap.stream-compatible provider URLs
- NIP-98 provider authentication through the active BudaBit signer
- OBS server URL and stream-key setup
- Community-tagged NIP-53 kind `30311` discovery
- Publication to public and community relays
- Native HLS playback
- Kind `1311` live chat across public and community relays
- Moderator authority resolved privately by the BudaBit host
- Multiple planned/live streams listed at once
- Host-managed `community:queryLiveStreams` polling with transient retry backoff
- Compact accordion by default with user-controlled expansion and automatic expansion when the community goes live

The widget does not store private keys or RTMP stream keys. Provider credentials remain in memory and are retrieved again after a reload.

## Architecture

The provider receives RTMP from OBS, creates HLS, and signs the addressable kind `30311` lifecycle event. The moderator is identified by the event's `p` tag with role `host`. The widget mirrors verified provider replacements to the community relays and selected public relays only while the current moderator's prepared provider session is active.

BudaBit's `community:queryLiveStreams` bridge action resolves section moderators from the hidden community runtime context. It accepts either a moderator-authored stream or a trusted-provider stream whose host is a moderator. The widget never receives the moderator pubkey set. Queries intentionally have no blanket `since` window so old but still planned/live replacements remain visible; ended and VOD entries are retained client-side for 30 days.

The hosted list continues to use bridge polling rather than `nostr:subscribe`. `COMMUNITY_CONTEXT_NOT_READY` and `COMMUNITY_QUERY_TIMEOUT` are retried with bounded exponential backoff while the last successful list remains visible. Moderator authority is cleared on every context-version change and on terminal capability errors, then restored only by a matching current-context capability response.

Chat updates, provider event detection, and profile refresh currently use finite direct `SimplePool.querySync` requests with per-request deadlines; they are polling-based and may lag by several seconds. The shared pool closes relays removed from active chat/provider/profile scopes, prunes idle connections, and is destroyed when the widget unmounts. Profile metadata is refreshed after a five-minute TTL.

If the host includes an action capability catalog in `widget:init`, the widget uses it additively to gate stream discovery, studio access, provider authorization, and chat publishing. Hosts that omit the catalog keep the legacy optimistic behavior.

## Development

This repository expects a sibling BudaBit checkout because the SDK is currently linked locally.

```sh
pnpm install
pnpm dev
pnpm test
pnpm check
```

Copy `.env.example` to `.env` to override the provider, public relay set, or trusted provider pubkeys.

## Widget Build

```sh
pnpm widget:build
```

The Vite build inlines JavaScript and CSS into `dist/index.html`. The manifest generator writes the unsigned kind `30033` files to `dist/widget`.

For a real release, upload `assets/stream-icon.svg` and `dist/index.html`, then set:

```sh
WIDGET_APP_URL=https://your-widget-artifact.example/index.html
WIDGET_ICON_URL=https://your-icon.example/icon.svg
WIDGET_IMAGE_URL=https://your-icon.example/icon.svg
pnpm manifest
```

The generated manifest requests:

- `community:checkWriteCapabilities`
- `community:queryLiveStreams`
- `nostr:publish`
- `nostr:sign`
- `ui:toast`
- `ui:resize`

It renders in `community-home-after-quicklinks`.

## Provider Notes

Starting media means starting the OBS encoder. The widget intentionally does not expose a dedicated live publish or provider-stop API; stop the broadcast in OBS. The provider updates the NIP-53 event to `ended` when ingest disconnects. Automatic replacement mirroring expires after six hours and is limited to the provider/address detected for the current moderator-initiated prepared session.

The standard zap-stream provider API does not return its Nostr signer or a newly prepared stream identifier. The widget resolves the selected API URL against a trusted NIP-89 provider advertisement (or an explicit trusted provider hint), then writes a unique per-preparation tag through that provider. If no stream identifier is returned, initial detection uses the strictest available binding: the resolved provider, exact preparation tag, current viewer host tag, community tag, active status, and preparation time window. The first match pins the stream address. Providers that cannot establish a trusted signer identity are rejected.

Self-hosted zap-stream-core is optional. A self-hosted deployment should add its provider pubkey to both BudaBit's `VITE_TRUSTED_LIVE_STREAM_PROVIDER_PUBKEYS` and this widget's `VITE_TRUSTED_STREAM_PROVIDER_PUBKEYS`.
