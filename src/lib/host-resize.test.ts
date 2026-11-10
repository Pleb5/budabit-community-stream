import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostResizer, RESIZE_FALLBACK_MS } from "./host-resize";

describe("offscreen stream sizing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Simulate an offscreen iframe: callbacks are accepted but never painted.
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports the latest height without a paint and cannot be starved by repeated signals", async () => {
    let height = 80;
    const request = vi.fn(async () => ({}));
    const resizer = createHostResizer({ measure: () => height, request });
    resizer.schedule();
    await vi.advanceTimersByTimeAsync(RESIZE_FALLBACK_MS - 1);
    height = 420;
    resizer.schedule();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls).toEqual([[420]]);
    resizer.destroy();
  });

  it("can expand while an older resize ACK is pending and retries after a host reset", async () => {
    let height = 80;
    const request = vi.fn(() => new Promise(() => {}));
    const resizer = createHostResizer({ measure: () => height, request });
    resizer.schedule();
    await vi.advanceTimersByTimeAsync(RESIZE_FALLBACK_MS);
    height = 620;
    resizer.schedule();
    await vi.advanceTimersByTimeAsync(RESIZE_FALLBACK_MS);
    resizer.reset();
    await vi.advanceTimersByTimeAsync(RESIZE_FALLBACK_MS);
    expect(request.mock.calls).toEqual([[80], [620], [620]]);
    resizer.destroy();
  });

  it("retries rejected resize responses and cancels work on unmount", async () => {
    const request = vi.fn().mockResolvedValueOnce({ error: "not ready" }).mockResolvedValue({});
    const resizer = createHostResizer({ measure: () => 90, request });
    resizer.schedule();
    await vi.advanceTimersByTimeAsync(RESIZE_FALLBACK_MS);
    resizer.schedule();
    await vi.advanceTimersByTimeAsync(RESIZE_FALLBACK_MS);
    expect(request).toHaveBeenCalledTimes(2);
    resizer.reset();
    resizer.destroy();
    await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
