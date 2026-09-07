import { createServer, type Server } from "node:http";

/**
 * T-2302: apps/worker has no other HTTP surface (it is a pure queue
 * consumer) — this is the ONLY thing a container orchestrator (Docker
 * HEALTHCHECK, an ECS-class scheduler) can probe to tell "process started
 * and subscribed" apart from "process crashed on startup before ever
 * reaching main()'s catch handler" (a hung `pnpm install`/module resolution
 * failure would otherwise look identical to a healthy container from the
 * outside). Started by `main()` only after `queue.subscribe` succeeds, not
 * at process start, so a container only reports healthy once it is
 * genuinely consuming.
 */
export function startHealthServer(port: number): Server {
  const server = createServer((request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  // N6 real fault-injection finding (Feature 23, same bug class as
  // T-2307's `db/pool.ts` fix): `http.Server.listen()` failing (most
  // commonly `EADDRINUSE` — a real, observed case is `worker-independence
  // .integration.test.ts`'s own kill-then-immediately-respawn sequence
  // racing the OS's socket cleanup) emits an unhandled `'error'` event,
  // which Node's default behavior turns into a process-crashing `throw`.
  // A health endpoint is a genuinely OPTIONAL, best-effort observability
  // surface — its own failure must never take down the real thing this
  // process exists to do (consuming the queue, already subscribed by the
  // time this is called). Logged, not thrown.
  server.on("error", (error) => {
    console.error("health-server: failed to start (queue consumption is unaffected)", {
      message: error.message,
      name: error.name,
    });
  });
  server.listen(port);
  return server;
}
