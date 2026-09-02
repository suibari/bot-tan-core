import { ServiceTier, type GenerateContentParameters } from '@google/genai';
import { resolveAiRoute, type AiFeatureKey } from '@bsky-affirmative-bot/shared-configs';

/**
 * レジストリの tier 文字列を @google/genai の enum に変換する。
 * undefined を返した場合は config に serviceTier を積まない（= Google 既定に任せる）。
 * ServiceTier enum を知っているのはこのファイルだけにする。
 */
export function toServiceTier(tier?: 'flex' | 'standard'): ServiceTier | undefined {
  if (tier === 'standard') return ServiceTier.STANDARD;
  if (tier === 'flex') return ServiceTier.FLEX;
  return undefined;
}

/**
 * gemini.models.generateContent を直接叩く箇所用。
 * 機能キーからモデルを差し込み、必要なら config.serviceTier も足す。
 * 呼び出し側は model を書かない（書けない）。
 */
export function withRoute(
  feature: AiFeatureKey,
  params: Omit<GenerateContentParameters, 'model'>,
): GenerateContentParameters {
  const route = resolveAiRoute(feature);
  const serviceTier = toServiceTier(route.serviceTier);
  return {
    ...params,
    model: route.model,
    config: {
      ...params.config,
      // ルートが "auto" のときは serviceTier を積まない
      ...(serviceTier ? { serviceTier } : {}),
    },
  };
}
