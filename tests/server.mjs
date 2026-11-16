import {createServer} from "vite";
import {fileURLToPath} from "node:url";
import {readFile} from "node:fs/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const hiveRoot = new URL("../../hivetalksfu/", import.meta.url);
const server = await createServer({
  root,
  server: {host: "127.0.0.1", port: 5188, strictPort: true},
  plugins: [{
    name: "local-presentation-fixtures",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader("Content-Security-Policy", "connect-src 'self' ws://localhost:5188 ws://127.0.0.1:5188; frame-src http://localhost:5188 http://127.0.0.1:5188");
        const files = {
          "/tests/screen-share.html": ["tests/integration/screen-share-controls.html", "text/html"],
          "/tests/room-client.js": ["public/js/RoomClient.js", "text/javascript"],
          "/tests/room.css": ["public/css/Room.css", "text/css"],
        };
        const file = files[req.url?.split("?")[0]];
        if (!file) return next();
        readFile(new URL(file[0], hiveRoot)).then(bytes => {
          res.setHeader("Content-Type", file[1]);
          res.end(bytes);
        }).catch(next);
      });
    },
  }],
});
await server.listen();
server.printUrls();
