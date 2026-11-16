<script lang="ts">
  import Hls from "hls.js";
  import {StreamAudioPolicy, type LocalMediaState} from "./lib/stream-audio";

  let {
    src,
    poster = "",
    title = "Live stream",
    audioContext = {ready: false, callActive: false, broadcastPrepared: false},
    streamKey = src,
  }: { src: string; poster?: string; title?: string; audioContext?: LocalMediaState; streamKey?: string } = $props();
  let video = $state<HTMLVideoElement | null>(null);
  let error = $state("");
  let shell = $state<HTMLDivElement | null>(null);
  let muted = $state(true);
  let fullscreen = $state(false);
  let presentationError = $state("");
  let autoplayNotice = $state("");
  const audioPolicy = new StreamAudioPolicy();
  let playbackAttempt = 0;
  let defaultedStream: string | undefined;
  const audioNotice = $derived(
    audioContext.callActive
      ? "Stream audio starts muted because your call is open on this page. Listening to both produces delayed duplicate voices."
      : audioContext.broadcastPrepared
        ? "Stream audio starts muted because broadcasting was prepared in this tab. Keep it muted while OBS captures playback."
        : !audioContext.ready
          ? "Checking local call and broadcast participation. Audio stays muted until this host confirms it, or you choose."
          : "You are watching only the stream. Use the audio controls to mute or unmute."
  );

  async function tryPlayback() {
    const element = video;
    if (!element) return;
    const attempt = ++playbackAttempt;
    try {
      await element.play();
      if (attempt === playbackAttempt) autoplayNotice = "";
    } catch (failure) {
      if (attempt !== playbackAttempt || element !== video) return;
      if (failure instanceof DOMException && failure.name === "NotAllowedError" && !element.muted) {
        audioPolicy.autoplayBlocked();
        muted = true;
        element.muted = true;
        autoplayNotice = "Your browser blocked playback with sound. Select Unmute stream to listen.";
        void element.play().catch(() => {});
      }
    }
  }

  function chooseAudio() {
    muted = !muted;
    audioPolicy.choose(muted);
    if (video) video.muted = muted;
    autoplayNotice = "";
    void tryPlayback();
  }

  function nativeAudioChanged() {
    if (video && video.muted !== audioPolicy.muted) {
      audioPolicy.choose(video.muted);
      muted = video.muted;
      autoplayNotice = "";
    }
  }

  $effect(() => {
    const shouldMute = audioPolicy.update(streamKey, audioContext);
    const element = video;
    muted = shouldMute;
    if (element) element.muted = shouldMute;
    if (element && audioContext.ready && defaultedStream !== streamKey) {
      defaultedStream = streamKey;
      if (!shouldMute) void tryPlayback();
    }
  });

  async function toggleFullscreen() {
    presentationError = "";
    try {
      if (document.fullscreenElement === shell) await document.exitFullscreen();
      else if (shell?.requestFullscreen) await shell.requestFullscreen();
      else throw new Error("Unavailable");
    } catch {
      presentationError = "Full screen is unavailable here. Use Enlarge above the widget in Budabit.";
    }
  }

  $effect(() => {
    const element = video;
    const source = src;
    if (!element || !source) return;

    error = "";
    let hls: Hls | null = null;
    const isHls = (() => {
      try {
        return /\.m3u8?$/i.test(new URL(source).pathname);
      } catch {
        return false;
      }
    })();
    if (!isHls || element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = source;
      void tryPlayback();
    } else if (Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, enableWorker: true });
      hls.loadSource(source);
      hls.attachMedia(element);
      hls.on(
        Hls.Events.MANIFEST_PARSED,
        () => void tryPlayback(),
      );
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) error = "The live video could not be loaded.";
      });
    } else {
      error = "This browser cannot play this HLS stream.";
    }

    return () => {
      playbackAttempt++;
      hls?.destroy();
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  });
</script>

<svelte:document onfullscreenchange={() => fullscreen = document.fullscreenElement === shell} />

<div bind:this={shell} class="player-shell">
  <div class="player-controls">
    <button onclick={chooseAudio}>{muted ? "Unmute stream" : "Mute stream"}</button>
    <button onclick={() => void toggleFullscreen()}>{fullscreen ? "Exit full screen" : "Full screen stream"}</button>
  </div>
  <video
    bind:this={video}
    bind:muted
    onvolumechange={nativeAudioChanged}
    {poster}
    aria-label={title}
    controls
    playsinline
    autoplay
  ></video>
  {#if error}<p class="player-error" role="alert">{error}</p>{/if}
  {#if presentationError}<p class="player-error" role="alert">{presentationError}</p>{/if}
</div>
<p class="audio-notice" role="status">{audioNotice}</p>
{#if autoplayNotice}<p class="audio-notice" role="status">{autoplayNotice}</p>{/if}

<style>
  .player-shell {
    position: relative;
    overflow: hidden;
    width: 100%;
    background: #030712;
    border-radius: 18px;
  }
  video {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: contain;
  }
  .player-controls { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px; }
  button { border: 1px solid #64748b; border-radius: 8px; background: #1e293b; color: #fff; padding: 8px 12px; font: inherit; cursor: pointer; }
  .player-shell:fullscreen { display: flex; flex-direction: column; width: 100%; height: 100%; border-radius: 0; }
  .player-shell:fullscreen video { flex: 1; min-height: 0; height: 0; aspect-ratio: auto; }
  .audio-notice { font: 0.8rem/1.5 system-ui; color: inherit; }
  .player-error {
    position: absolute;
    inset: auto 1rem 1rem;
    margin: 0;
    border-radius: 10px;
    padding: 0.7rem 0.9rem;
    color: #fff1f2;
    background: rgb(159 18 57 / 0.9);
    font:
      600 0.85rem/1.3 system-ui,
      sans-serif;
  }
</style>
