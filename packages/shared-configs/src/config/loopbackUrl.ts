/**
 * 同一ホスト内だけに公開する内部APIのURLを、待受portと同じ環境変数から組み立てる。
 * hostを設定可能にすると、受信側が127.0.0.1へbindしているという認可境界と食い違うため、
 * loopback以外は受け付けない。
 */
export function loopbackUrlFromPort(
  portEnvName: string,
  defaultPort: number,
): string {
  const raw = process.env[portEnvName]?.trim();
  const port = raw ? Number(raw) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${portEnvName} must be an integer between 1 and 65535`);
  }
  return `http://127.0.0.1:${port}`;
}
