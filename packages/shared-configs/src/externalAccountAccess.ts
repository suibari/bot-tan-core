/**
 * Worktrees commonly use a copied .env with live credentials and a local DB.
 * External account access must therefore be an explicit development opt-in.
 */
export function assertExternalAccountAccessAllowed(
  service: string,
  developmentOverride: string,
  env: Record<string, string | undefined>,
) {
  if (env.NODE_ENV === "production" || env[developmentOverride] === "true") return;
  throw new Error(
    `${service} is disabled outside NODE_ENV=production. ` +
      `Set ${developmentOverride}=true only when intentionally testing with a disposable account.`,
  );
}
