import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeInlineScript = (value: string) =>
  value.replace(/<\/script/gi, "<\\/script");
const escapeInlineStyle = (value: string) =>
  value.replace(/<\/style/gi, "<\\/style");

const singleFile = (): Plugin => ({
  name: "budabit-single-file",
  enforce: "post",
  generateBundle(_, bundle) {
    const htmlAsset = Object.values(bundle).find(
      (item) => item.type === "asset" && item.fileName === "index.html",
    );
    if (
      !htmlAsset ||
      htmlAsset.type !== "asset" ||
      typeof htmlAsset.source !== "string"
    )
      return;

    let html = htmlAsset.source;
    for (const [fileName, item] of Object.entries(bundle)) {
      const filePattern = `/?${escapeRegExp(fileName)}`;
      if (item.type === "chunk" && fileName.endsWith(".js")) {
        html = html.replace(
          new RegExp(
            `<script\\b[^>]*src=["']${filePattern}["'][^>]*><\\/script>`,
          ),
          () =>
            `<script type="module">${escapeInlineScript(item.code)}</script>`,
        );
        delete bundle[fileName];
      }
      if (
        item.type === "asset" &&
        fileName.endsWith(".css") &&
        typeof item.source === "string"
      ) {
        html = html.replace(
          new RegExp(`<link\\b[^>]*href=["']${filePattern}["'][^>]*>`),
          () => `<style>${escapeInlineStyle(item.source as string)}</style>`,
        );
        delete bundle[fileName];
      }
    }
    htmlAsset.source = html;
  },
});

export default defineConfig({
  plugins: [svelte(), singleFile()],
  build: { target: "es2022" },
});
