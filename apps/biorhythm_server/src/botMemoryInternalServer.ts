import express, { type Express } from "express";
import http, { type Server } from "node:http";
import { createBotMemoryRouter, type BotMemoryRouterOptions } from "./botMemoryRouter.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3003;

export type BotMemoryInternalServerConfig = {
  host: string;
  port: number;
};

export function readBotMemoryInternalServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): BotMemoryInternalServerConfig {
  const host = env.BIORHYTHM_MEMORY_API_HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.BIORHYTHM_MEMORY_API_PORT?.trim();
  const port = rawPort === undefined || rawPort === "" ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BIORHYTHM_MEMORY_API_PORT must be an integer between 1 and 65535");
  }
  return { host, port };
}

export function createBotMemoryInternalApp(
  secret: string | undefined,
  options: BotMemoryRouterOptions = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use(createBotMemoryRouter(secret, options));
  return app;
}

export function startBotMemoryInternalServer(options: {
  config: BotMemoryInternalServerConfig;
  secret: string | undefined;
} & BotMemoryRouterOptions): Server {
  const server = http.createServer(createBotMemoryInternalApp(options.secret, {
    getPresence: options.getPresence,
  }));
  const { host, port } = options.config;
  server.listen(port, host, () => {
    console.log(`[INFO][BOT_MEMORY_API] Internal API listening on http://${host}:${port}`);
  });
  return server;
}
