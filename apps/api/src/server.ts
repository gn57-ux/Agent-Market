import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env.API_PORT ?? 3001);

app
  .listen({ port, host: "0.0.0.0" })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
