import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { createOfficeFundsReader, type OfficeFundsReader } from "./funds-reader.js";
import { buildOfficeSnapshot } from "./service.js";

function sessionAddress(request: FastifyRequest, reply: FastifyReply): `0x${string}` | undefined {
  const address = request.address;
  if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
    void reply.status(401).send({ error: { message: "未检测到有效会话。" } });
    return undefined;
  }
  return `0x${address.slice(2)}`;
}

export function registerOfficeRoutes(
  app: FastifyInstance,
  pool: Pool,
  fundsReader: OfficeFundsReader = createOfficeFundsReader(),
): void {
  app.get("/office/snapshot", { preHandler: app.requireSession }, async (request, reply) => {
    const address = sessionAddress(request, reply);
    if (!address) return;
    return reply.send(await buildOfficeSnapshot(pool, fundsReader, address));
  });
}
