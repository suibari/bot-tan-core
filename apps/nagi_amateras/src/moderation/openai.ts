import OpenAI from "openai";

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  rawResponse: OpenAI.Moderations.ModerationCreateResponse;
}

export class OpenAIModerator {
  private openai: OpenAI;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
  }

  /**
   * テキストおよび（任意で）画像URLを omni-moderation-latest で判定
   */
  async evaluate(
    text: string,
    imageUrls?: string[],
  ): Promise<ModerationResult> {
    const inputs: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [];

    if (text && text.trim().length > 0) {
      inputs.push({ type: "text", text: text.trim() });
    }

    if (imageUrls && imageUrls.length > 0) {
      for (const url of imageUrls) {
        if (url) {
          inputs.push({ type: "image_url", image_url: { url } });
        }
      }
    }

    if (inputs.length === 0) {
      return {
        flagged: false,
        categories: {},
        categoryScores: {},
        rawResponse: {
          id: "empty",
          model: "omni-moderation-latest",
          results: [],
        },
      };
    }

    const response = await this.openai.moderations.create({
      model: "omni-moderation-latest",
      input: inputs as any,
    });

    const result = response.results[0];

    return {
      flagged: result?.flagged ?? false,
      categories:
        (result?.categories as unknown as Record<string, boolean>) || {},
      categoryScores:
        (result?.category_scores as unknown as Record<string, number>) || {},
      rawResponse: response,
    };
  }
}
