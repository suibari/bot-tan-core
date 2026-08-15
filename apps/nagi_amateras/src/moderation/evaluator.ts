import { OpenAIModerator, ModerationResult } from "./openai.js";
import {
  evaluateModerationResult,
  DEFAULT_THRESHOLDS,
  ThresholdConfig,
  EvaluationAction,
} from "./rules.js";

export interface PostEvaluationInput {
  uri?: string;
  text: string;
  imageUrls?: string[];
}

export interface PostEvaluationOutput {
  uri?: string;
  text: string;
  result: ModerationResult;
  evaluation: EvaluationAction;
}

export class ContentEvaluator {
  private moderator: OpenAIModerator;
  private thresholds: ThresholdConfig;

  constructor(
    apiKey?: string,
    thresholds: ThresholdConfig = DEFAULT_THRESHOLDS,
  ) {
    this.moderator = new OpenAIModerator(apiKey);
    this.thresholds = thresholds;
  }

  async evaluatePost(
    input: PostEvaluationInput,
  ): Promise<PostEvaluationOutput> {
    const result = await this.moderator.evaluate(input.text, input.imageUrls);
    const evaluation = evaluateModerationResult(result, this.thresholds);

    return {
      uri: input.uri,
      text: input.text,
      result,
      evaluation,
    };
  }

  async evaluateBatch(
    inputs: PostEvaluationInput[],
    concurrency = 5,
  ): Promise<PostEvaluationOutput[]> {
    const outputs: PostEvaluationOutput[] = [];
    const queue = [...inputs];

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        try {
          const res = await this.evaluatePost(item);
          outputs.push(res);
        } catch (err) {
          console.error(
            `Error evaluating post ${item.uri || item.text.slice(0, 20)}:`,
            err,
          );
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, inputs.length) },
      () => worker(),
    );
    await Promise.all(workers);

    return outputs;
  }
}
