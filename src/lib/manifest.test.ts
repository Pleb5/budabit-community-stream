import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

describe("widget manifest", () => {
  it("keeps the manifest release version aligned with the package", () => {
    expect(packageJson.scripts.manifest).toContain(`--version '${packageJson.version}'`);
    expect(packageJson.scripts.manifest).toContain("community:getMediaState,community:setMediaState");
  });
  it("uses release-safe icon defaults", () => {
    const manifestScript = packageJson.scripts.manifest;

    expect(manifestScript).toContain("01a9cedaa2abe5f3950e9302e28c030e887131a436ae73c6ab3d39ef7f764240.svg");
    expect(manifestScript).not.toContain("example.com/budabit-community-stream/icon.svg");
  });
});
