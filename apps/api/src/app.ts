import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { getPool } from "./db/pool.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";

export interface BuildAppOptions {
  /** Test seam: pass a Pool bound to a throwaway test database instead of
   * the module-level singleton (which reads DATABASE_URL). Production
   * callers (server.ts) omit this and get `getPool()`. */
  pool?: Pool;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const pool = options.pool ?? getPool();

  void app.register(cookie);

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerAuthRoutes(app, pool);

  return app;
}
