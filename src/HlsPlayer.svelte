<script lang="ts">
  import Hls from "hls.js";

  let {
    src,
    poster = "",
    title = "Live stream",
  }: { src: string; poster?: string; title?: string } = $props();
  let video = $state<HTMLVideoElement | null>(null);
  let error = $state("");

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
      void element.play().catch(() => {});
    } else if (Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, enableWorker: true });
      hls.loadSource(source);
      hls.attachMedia(element);
      hls.on(
        Hls.Events.MANIFEST_PARSED,
        () => void element.play().catch(() => {}),
      );
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) error = "The live video could not be loaded.";
      });
    } else {
      error = "This browser cannot play this HLS stream.";
    }

    return () => {
      hls?.destroy();
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  });
</script>

<div class="player-shell">
  <video
    bind:this={video}
    {poster}
    aria-label={title}
    controls
    playsinline
    autoplay
  ></video>
  {#if error}<p class="player-error" role="alert">{error}</p>{/if}
</div>

<style>
  .player-shell {
    position: relative;
    overflow: hidden;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #030712;
    border-radius: 18px;
  }
  video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
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
