import { config } from "../config.js";

export const AMATERAS_RULE_VERSION = "amateras-v1";

export type AmaterasDecision = {
  action: "none" | "label" | "drop";
  labels: string[];
  maxScore: number;
  highestCategory: string;
};

const ACTIONS = new Set(["none", "label", "drop"]);

export async function evaluateNagiPost(input: {
  uri: string;
  cid: string;
  did: string;
  record: unknown;
}): Promise<AmaterasDecision | undefined> {
  if (!config.amateras) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${config.amateras.url}/api/evaluate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.amateras.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(
        `Amateras evaluation failed with HTTP ${response.status}`,
      );
    const body = (await response.json()) as any;
    if (
      !ACTIONS.has(body?.action) ||
      !Array.isArray(body?.labels) ||
      !body.labels.every((label: unknown) => typeof label === "string") ||
      typeof body?.maxScore !== "number" ||
      typeof body?.highestCategory !== "string"
    ) {
      throw new Error("Amateras returned an invalid evaluation response");
    }
    return {
      action: body.action,
      labels: body.labels,
      maxScore: body.maxScore,
      highestCategory: body.highestCategory,
    };
  } finally {
    clearTimeout(timeout);
  }
}
