# BudaBit Community Stream

Streaming widget extension for BudaBit communities. Moderators prepare an OBS broadcast through a zap.stream-compatible provider; members watch HLS video and participate in NIP-53 live chat directly from the community home page.

## Current Scope

- Default endpoint discovered from trusted, signed NIP-89 provider advertisements
- Custom zap.stream-compatible provider URLs
- NIP-98 provider authentication through the active BudaBit signer
- OBS server URL and stream-key setup
- Community-tagged NIP-53 kind `30311` discovery
- Publication to public and community relays
- Native HLS playback
- Participation-aware audio defaults, explicit audio controls, and a visible fullscreen action
- Updated Budabit hosts offer in-page Enlarge and fullscreen without remounting the player
- Kind `1311` live chat across public and community relays
- Moderator authority resolved privately by the BudaBit host
- Multiple planned/live streams listed at once
- Host-managed `community:queryLiveStreams` polling with transient retry backoff
- Compact accordion by default with user-controlled expansion and automatic expansion when the community goes live
- Timer-backed sizing for offscreen frames, with fresh measurements after host initialization and viewport changes

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

With `VITE_STREAM_PROVIDER_URL` unset or empty, opening the moderator studio
discovers the provider URL from kind `31990` advertisements on the configured
public and community relays. Only valid signatures from trusted provider keys
advertising kind `30311` and `api:zap-stream` are accepted. Discovery uses the
latest replacement per provider/identifier and prefers the primary
`zap-stream-core` advertisement over regional alternatives. There is no hardcoded
API URL fallback. If discovery fails, use **Use advertised provider** to retry or
enter a custom URL. An explicit `VITE_STREAM_PROVIDER_URL` skips automatic
selection; manual edits are preserved while discovery is pending.

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

To broadcast a Community Call, join the call and use OBS window capture plus the
intended call audio output as the encoder source. HiveTalk on `calls.budabit.club`
currently has its server-side RTMP controls disabled; starting a call alone does
not start a Nostr broadcast. Prepare the provider in this widget, enter its ingest
server/key in OBS, and verify playback from a second participant before launch.

Keep the broadcaster's stream preview muted: headphones do not prevent Desktop Audio from recapturing browser playback. Verify both voices once in an OBS recording before going live.

Audio defaults use the host's `community:getMediaState` / `community:setMediaState` coordination, not stream author identity or moderator status. A call open/joining on the same community page or locally prepared broadcasting defaults to muted; a viewer without either requests sound. Joining a call or beginning broadcast preparation mutes existing playback, with a reason. Leaving/clearing protection never enables sound unexpectedly. Explicit mute/unmute choices survive normal state refreshes. Audible autoplay denial falls back to muted playback with a click-to-unmute prompt. Unsupported/unknown hosts stay muted until the viewer chooses.

Call state is ephemeral and removed when its iframe leaves/unmounts. Local broadcast intent is retained in the host tab's session storage (when available), scoped by exact community address and viewer account; it survives refresh because external OBS may still be running. Use **OBS outputs stopped: clear preview protection** only after stopping both outputs; it clears a hint, not OBS. Local preparation is reported once per setup rather than re-arming after an ordinary profile/context refresh. A second device/account is not muted merely because the same stream was started elsewhere. This coordination does not detect calls in other browser tabs/apps/devices or actual OBS outputs; mute manually in those cases. No presence is published to Nostr.

For private discussion, stop **both** OBS streaming and recording using its controls or separate explicit Stop hotkeys. Keep the embedded call connected, and verify both OBS timers have stopped. The widget cannot stop or verify external OBS outputs and must not report privacy based on hiding/muting its player or on delayed provider status. Public playback may drain buffered footage; other participants can record independently. Announce before restarting either output.

Presentation regression fixtures are served by `node tests/server.mjs` on port 5188. `/tests/player.html` uses a synthetic canvas stream in the actual player component; `/tests/player-host.html` wraps it in a cross-origin sandbox. `/tests/screen-share.html` exercises the sibling HiveTalk screen controls without device access. From the sibling Budabit checkout, run `playwright test -c playwright.community-presentation.config.ts` for desktop/mobile fullscreen, audio defaults, retained video identity, and screen focus checks. These do not verify live HLS transport, physical screen selection, or OBS.

The standard zap-stream provider API does not return its Nostr signer or a newly prepared stream identifier. The widget resolves the selected API URL against a trusted NIP-89 provider advertisement (or an explicit trusted provider hint), then writes a unique per-preparation tag through that provider. If no stream identifier is returned, initial detection uses the strictest available binding: the resolved provider, exact preparation tag, current viewer host tag, community tag, active status, and preparation time window. The first match pins the stream address. Providers that cannot establish a trusted signer identity are rejected.

Self-hosted zap-stream-core is optional. A self-hosted deployment should add its provider pubkey to both BudaBit's `VITE_TRUSTED_LIVE_STREAM_PROVIDER_PUBKEYS` and this widget's `VITE_TRUSTED_STREAM_PROVIDER_PUBKEYS`.
