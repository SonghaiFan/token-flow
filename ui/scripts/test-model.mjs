import { createServer } from "vite";
import { createServer as createHttpServer } from "node:http";

// Vite's module runner needs a transport, but these tests never listen on a port.
const transport = createHttpServer();
const server = await createServer({ server: { middlewareMode: true, ws: { server: transport } }, appType: "custom" });
try {
  await server.ssrLoadModule("/lib/token-model.test.ts");
} finally {
  await server.close();
}
