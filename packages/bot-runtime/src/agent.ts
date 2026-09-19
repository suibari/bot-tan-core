import { AtpAgent } from "@atproto/api";
import { assertExternalAccountAccessAllowed } from "@bsky-affirmative-bot/shared-configs/externalAccountAccess";

export type BotAgentOptions = {
  identifier: string | undefined;
  password: string | undefined;
  service?: string;
};

/** 開発用DBと本番PDSを同時に使っても、botの投稿だけが本番へ漏れないようにする。 */
export function assertBotPdsAccessAllowed(
  env: { NODE_ENV?: string; ALLOW_DEV_BOT_PDS_WRITES?: string } = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_DEV_BOT_PDS_WRITES: process.env.ALLOW_DEV_BOT_PDS_WRITES,
  },
) {
  assertExternalAccountAccessAllowed("Bot PDS login", "ALLOW_DEV_BOT_PDS_WRITES", env);
}

export function createBotAgent({
  identifier,
  password,
  service = "https://bsky.social",
}: BotAgentOptions) {
  const agent = new AtpAgent({ service });
  let accessJwt: string | null = null;
  let refreshJwt: string | null = null;

  async function login() {
    assertBotPdsAccessAllowed();
    if (!identifier || !password) {
      throw new Error("Bot identifier and app password are required");
    }

    const response = await agent.login({ identifier, password });
    accessJwt = response.data.accessJwt;
    refreshJwt = response.data.refreshJwt;
    console.log("[INFO] Created new AT Protocol session.");
  }

  async function createOrRefreshSession() {
    if (!accessJwt && !refreshJwt) {
      await login();
      return;
    }

    try {
      await agent.getTimeline();
    } catch (error: any) {
      if (
        error?.response?.data?.error === "ExpiredToken" ||
        error?.message?.includes("ExpiredToken")
      ) {
        const refresh = await agent.com.atproto.server.refreshSession();
        accessJwt = refresh.data.accessJwt;
        refreshJwt = refresh.data.refreshJwt;
        console.log("[INFO] Refreshed expired AT Protocol session.");
        return;
      }

      throw error;
    }
  }

  return { agent, login, createOrRefreshSession };
}
