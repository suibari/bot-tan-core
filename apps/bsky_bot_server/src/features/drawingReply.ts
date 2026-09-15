/**
 * お絵描き機能（DrawingFeature）の副作用を持たない部分。
 * DrawingFeature.ts は agent を読み込むので、テストからはこちらだけを引く。
 */

export type DrawingReplyKind = "drawn" | "declined" | "user_limit" | "service_limit" | "failed";

/**
 * お絵描きのリプライ本文。定型文にしている。
 *
 * 本文を LLM に書かせないのは、主役が絵のほうだから。絵を描くのに GPU を占有したうえに、
 * 本文の生成でさらに Ollama を待たせる理由が無い。
 */
export function drawingReplyText(
  kind: DrawingReplyKind,
  options: { langStr: string; name: string; subject?: string },
): string {
  const { name, subject } = options;
  if (options.langStr === "日本語") {
    switch (kind) {
      case "drawn":
        return `${name}さん、リクエストの「${subject}」を描いてみたよ！ クレヨンでがんばったから、受け取ってくれたらうれしいな。`;
      case "declined":
        return `${name}さん、リクエストありがとう！ でもごめんね、その絵はわたしには描けないんだ…。ほかのものなら描いてみるから、また頼んでね！`;
      case "user_limit":
        return `${name}さん、ごめんね、今はお絵描きできないみたい…。少ししたらまた頼んでね！`;
      case "service_limit":
        return `${name}さん、ごめんね、今日はたくさん描いて手がくたくたになっちゃった…。また明日頼んでくれるとうれしいな！`;
      case "failed":
        return `${name}さん、ごめんね、うまく描けなかったみたい…。少ししたらまた頼んでね！`;
    }
  }
  switch (kind) {
    case "drawn":
      return `${name}, I drew "${subject}" for you! I did my best with my crayons, so I hope you like it.`;
    case "declined":
      return `${name}, thank you for asking! I'm sorry, but that's not something I can draw... Ask me for something else and I'll give it a try!`;
    case "user_limit":
      return `${name}, I'm sorry, I can't draw that right now... Try asking me again in a little while!`;
    case "service_limit":
      return `${name}, I'm sorry, I drew so much today that my hands are worn out... Please ask me again tomorrow!`;
    case "failed":
      return `${name}, I'm sorry, the drawing didn't turn out... Try asking me again in a little while!`;
  }
}
