/** コミット済みの提出を即時生成する。通知を失ってもDBキューをワーカーが回収する。 */
export async function startZenkatsuComment(submissionUri: string): Promise<void> {
  try {
    const base = process.env.NAGI_BOT_SERVER_URL || "http://127.0.0.1:3003";
    const response = await fetch(`${base}/zenkatsu/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionUri }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.warn("[WARN][ZENKATSU] Immediate generation unavailable; worker will retry:", error);
  }
}
