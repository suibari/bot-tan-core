/**
 * Requests a Nagi client rebuild after indexable content changes.
 *
 * A failed hook must never make the publishing or indexing operation fail:
 * the next scheduled rebuild can still produce the prerendered HTML.
 */
export async function requestClientRebuild(
  reason: string,
  {
    deployHookUrl = process.env.NAGI_CLIENT_DEPLOY_HOOK_URL,
    fetchImpl = fetch,
  }: {
    deployHookUrl?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<boolean> {
  if (!deployHookUrl) return false;
  try {
    const response = await fetchImpl(deployHookUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(`[INFO][DEPLOY_HOOK] requested client rebuild (${reason})`);
    return true;
  } catch (error) {
    console.error(
      `[ERROR][DEPLOY_HOOK] client rebuild request failed (${reason}):`,
      error,
    );
    return false;
  }
}
