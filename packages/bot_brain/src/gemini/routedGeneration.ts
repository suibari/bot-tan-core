import {
  resolveAiRoute,
  type AiFeatureKey,
} from "@bsky-affirmative-bot/shared-configs";
import { toServiceTier } from "./aiRoute.js";
import { generateContentForProvider } from "./generationClient.js";
import { prepareOllamaGrounding } from "./grounding.js";

/** generateContentWithRetry を使わない既存箇所向けのprovider対応ルート。 */
export async function generateContentForFeature(
  feature: AiFeatureKey,
  params: any,
): Promise<any> {
  const route = resolveAiRoute(feature);
  const serviceTier = toServiceTier(route.serviceTier);
  let routed = {
    ...params,
    model: route.model,
    config: {
      ...params.config,
      ...(serviceTier ? { serviceTier } : {}),
    },
  };
  if (route.provider === "ollama") {
    routed = await prepareOllamaGrounding(feature, routed);
  }
  return generateContentForProvider(route.provider, routed);
}
