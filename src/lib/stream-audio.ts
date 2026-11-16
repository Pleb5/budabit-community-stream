export type LocalMediaState = {
  ready: boolean;
  callActive: boolean;
  broadcastPrepared: boolean;
};

/** Audio defaults for one selected stream. Safety transitions mute; leaving never unmutes. */
export class StreamAudioPolicy {
  muted = true;
  private stream = "";
  private initialized = false;
  private explicit = false;
  private protection = "";

  update(stream: string, state: LocalMediaState) {
    if (this.stream !== stream) {
      this.stream = stream;
      this.initialized = false;
      this.explicit = false;
      this.protection = "";
      this.muted = true;
    }
    const protection = state.callActive ? "call" : state.broadcastPrepared ? "broadcast" : "";
    if (protection && protection !== this.protection) {
      this.muted = true;
      this.explicit = false;
    }
    // A positive local safety signal already establishes a muted default.
    // A later empty snapshot must not turn sound on after that activity ends.
    if (protection) this.initialized = true;
    if (state.ready && !this.initialized) {
      if (!this.explicit) this.muted = Boolean(protection);
      this.initialized = true;
    }
    this.protection = protection;
    return this.muted;
  }

  choose(muted: boolean) {
    this.muted = muted;
    this.explicit = true;
  }

  autoplayBlocked() {
    this.muted = true;
  }
}
