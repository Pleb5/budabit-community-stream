import {describe, expect, it} from "vitest";
import {StreamAudioPolicy, type LocalMediaState} from "./stream-audio";

const viewer: LocalMediaState = {ready: true, callActive: false, broadcastPrepared: false};
const caller: LocalMediaState = {...viewer, callActive: true};
const broadcaster: LocalMediaState = {...viewer, broadcastPrepared: true};

describe("participation-aware stream audio", () => {
  it("waits for participation state, then starts an ordinary viewer with sound", () => {
    const policy = new StreamAudioPolicy();
    expect(policy.update("stream", {...viewer, ready: false})).toBe(true);
    expect(policy.update("stream", viewer)).toBe(false);
  });
  for (const [name, state] of [["caller", caller], ["local broadcaster", broadcaster]] as const) {
    it(`starts a ${name} muted`, () => {
      expect(new StreamAudioPolicy().update("stream", state)).toBe(true);
    });
  }
  it("mutes when a viewer joins the call; leaving does not unexpectedly unmute", () => {
    const policy = new StreamAudioPolicy();
    expect(policy.update("stream", viewer)).toBe(false);
    expect(policy.update("stream", caller)).toBe(true);
    expect(policy.update("stream", viewer)).toBe(true);
  });
  it("mutes when broadcast preparation begins, not merely when someone moderates", () => {
    const policy = new StreamAudioPolicy();
    expect(policy.update("stream", viewer)).toBe(false);
    expect(policy.update("stream", broadcaster)).toBe(true);
    expect(policy.update("stream", viewer)).toBe(true);
  });
  it("respects explicit mute/unmute while participation state is unchanged", () => {
    const policy = new StreamAudioPolicy();
    policy.update("stream", caller);
    policy.choose(false);
    expect(policy.update("stream", caller)).toBe(false);
    policy.choose(true);
    expect(policy.update("stream", viewer)).toBe(true);
  });
  it("re-applies safety muting on a new call entry even after a prior override", () => {
    const policy = new StreamAudioPolicy();
    policy.update("stream", caller);
    policy.choose(false);
    policy.update("stream", viewer);
    expect(policy.update("stream", caller)).toBe(true);
  });
  it("does not undo a user's choice made before initial state arrives", () => {
    const policy = new StreamAudioPolicy();
    policy.update("stream", {...viewer, ready: false});
    policy.choose(true);
    expect(policy.update("stream", viewer)).toBe(true);
  });
  it("applies defaults to a newly selected stream without re-enabling sound on mere refreshes", () => {
    const policy = new StreamAudioPolicy();
    policy.update("first", viewer);
    policy.choose(true);
    expect(policy.update("first", viewer)).toBe(true);
    expect(policy.update("second", viewer)).toBe(false);
  });
  it("keeps a browser's autoplay fallback muted until the user chooses", () => {
    const policy = new StreamAudioPolicy();
    policy.update("stream", viewer);
    policy.autoplayBlocked();
    expect(policy.update("stream", viewer)).toBe(true);
    policy.choose(false);
    expect(policy.update("stream", viewer)).toBe(false);
  });
  it("does not unmute when protection ends before the first host snapshot arrives", () => {
    const policy = new StreamAudioPolicy();
    expect(policy.update("stream", {...broadcaster, ready: false})).toBe(true);
    expect(policy.update("stream", viewer)).toBe(true);
  });
});
