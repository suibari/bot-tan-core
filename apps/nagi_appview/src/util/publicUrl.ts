/**
 * この AppView 自身の公開オリジン（ビューやモデレーションへ渡す絶対 URL の基点）。
 * config を import すると必須 env の検証が走って呼び出し側のモジュール単体を読めなくなる
 * ので、ここでは遅延して env から解決する（導出規則は config.publicUrl と同じ）。
 */
let cachedPublicUrl: string | undefined;
export function appviewPublicUrl(): string {
  if (cachedPublicUrl) return cachedPublicUrl;
  const override = process.env.NAGI_APPVIEW_PUBLIC_URL;
  if (override) return (cachedPublicUrl = override.replace(/\/$/, ""));
  const appviewDid =
    process.env.NAGI_APPVIEW_DID ?? "did:web:nagi-api.suibari.com";
  if (!appviewDid.startsWith("did:web:"))
    throw new Error(
      "NAGI_APPVIEW_PUBLIC_URL is required when NAGI_APPVIEW_DID is not a did:web",
    );
  return (cachedPublicUrl = `https://${decodeURIComponent(
    appviewDid.slice("did:web:".length),
  )}`);
}
