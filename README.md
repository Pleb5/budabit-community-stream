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

The widget does not store private keys or RTMP stream keys. Provider credentials remain in memory and are retrieved again after a reload.

## Architecture

The provider receives RTMP from OBS, creates HLS, and signs the addressable kind `30311` lifecycle event. The moderator is identified by the event's `p` tag with role `host`. The widget mirrors verified provider replacements to the community relays and selected public relays.

BudaBit's `community:queryLiveStreams` bridge action resolves section moderators from the hidden community runtime context. It accepts either a moderator-authored stream or a trusted-provider stream whose host is a moderator. The widget never receives the moderator pubkey set.

## Development

This repository expects a sibling BudaBit checkout because the SDK is currently linked locally.

```sh
pnpm install
pnpm dev
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

It renders in `community-home-before-quicklinks`.

## Provider Notes

Starting media means starting the OBS encoder. The first release intentionally does not attempt to stop a provider pipeline remotely; stop the broadcast in OBS. The provider updates the NIP-53 event to `ended` when ingest disconnects.

Self-hosted zap-stream-core is optional. A self-hosted deployment should add its provider pubkey to both BudaBit's `VITE_TRUSTED_LIVE_STREAM_PROVIDER_PUBKEYS` and this widget's `VITE_TRUSTED_STREAM_PROVIDER_PUBKEYS`.
