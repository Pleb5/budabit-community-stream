import {mount, tick} from "svelte";
import PlayerFixture from "./PlayerFixture.svelte";

mount(PlayerFixture, {target: document.querySelector("#player")!, props: {
  initialMode: new URLSearchParams(location.search).get("mode") || "caller",
}});
await tick();
const video = document.querySelector("video")!;
const canvas = document.createElement("canvas");
canvas.width = 960;
canvas.height = 540;
const context = canvas.getContext("2d")!;
let counter = 0;
function draw() {
  context.fillStyle = "#243447";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fb923c";
  context.font = "bold 44px system-ui";
  context.fillText("Community stream preview", 40, 180);
  context.fillStyle = "#fff";
  context.font = "28px system-ui";
  context.fillText("Synthetic video · no devices or public services", 40, 250);
  context.fillText(`Frame ${++counter}`, 40, 320);
}
draw();
video.srcObject = canvas.captureStream(5);
setInterval(draw, 200);
void video.play().catch(() => {});
