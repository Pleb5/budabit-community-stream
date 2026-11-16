<script lang="ts">
  import HlsPlayer from "../src/HlsPlayer.svelte";
  import {untrack} from "svelte";
  let {initialMode = "caller"}: {initialMode?: string} = $props();
  let state = $state(untrack(() => ({
    ready: initialMode !== "unknown",
    callActive: initialMode === "caller",
    broadcastPrepared: initialMode === "broadcaster",
  })));
  let streamKey = $state("synthetic");
</script>

<div>
  <button onclick={() => state = {...state, ready: true, callActive: true}}>Join call</button>
  <button onclick={() => state = {...state, ready: true, callActive: false}}>Leave call</button>
  <button onclick={() => state = {...state, ready: true, broadcastPrepared: true}}>Prepare broadcast</button>
  <button onclick={() => state = {...state, ready: true, broadcastPrepared: false}}>Clear broadcast protection</button>
  <button onclick={() => state = {...state}}>Refresh participation</button>
  <button onclick={() => state = {...state, ready: true}}>Confirm participation</button>
  <button onclick={() => streamKey += "-next"}>Select another stream</button>
</div>
<HlsPlayer src="" title="Synthetic stream" audioContext={state} {streamKey} />
