export type ThreadOrderNode = {
  uri: string;
  parentUri?: string | null;
  /** 比較用の時刻（ミリ秒）。 */
  time: number;
};

/**
 * スレッドの返信を、会話の枝ごとにまとめた順へ並べる。
 *
 * 単純な時系列だと、ルートA → 返信A1 → 返信B → A1への返信A2 が
 * 「A1, B, A2」と並び、A2 が B への返信に見えてしまう。
 * そこで深さ優先でたどり、親の直後に子の枝を置く。兄弟の枝は「枝の中で最後に
 * 発言があった時刻」の昇順に並べるので、いま動いている会話が一番下に来る
 * （上の例は「B, A1, A2」）。
 *
 * 親が見つからない返信（削除済み・ミュート・未取り込み）はルート直下の枝として扱い、
 * 循環参照があっても全件を一度ずつ返す。
 */
export function orderThreadReplies<T>(
  rootUri: string,
  items: T[],
  toNode: (item: T) => ThreadOrderNode,
): T[] {
  const nodes = items.map((item) => ({ item, ...toNode(item) }));
  const known = new Set(nodes.map((n) => n.uri));
  const children = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (node.uri === rootUri) continue;
    const parent =
      node.parentUri && node.parentUri !== node.uri && known.has(node.parentUri)
        ? node.parentUri
        : rootUri;
    const list = children.get(parent) ?? [];
    if (!children.has(parent)) children.set(parent, list);
    list.push(node);
  }

  // 枝ごとの最終発言時刻。循環していても止まるよう、訪問中の印を持つ。
  const latest = new Map<string, number>();
  const visiting = new Set<string>();
  const latestOf = (node: (typeof nodes)[number]): number => {
    const cached = latest.get(node.uri);
    if (cached !== undefined) return cached;
    if (visiting.has(node.uri)) return node.time;
    visiting.add(node.uri);
    let max = node.time;
    for (const child of children.get(node.uri) ?? [])
      max = Math.max(max, latestOf(child));
    visiting.delete(node.uri);
    latest.set(node.uri, max);
    return max;
  };
  const cmp = (a: (typeof nodes)[number], b: (typeof nodes)[number]) =>
    latestOf(a) - latestOf(b) ||
    a.time - b.time ||
    (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);

  const out: T[] = [];
  const emitted = new Set<string>();
  const walk = (parentUri: string) => {
    for (const child of (children.get(parentUri) ?? []).slice().sort(cmp)) {
      if (emitted.has(child.uri)) continue;
      emitted.add(child.uri);
      out.push(child.item);
      walk(child.uri);
    }
  };
  walk(rootUri);
  // ルートへ繋がらない循環の残りは、時系列で末尾に置く。
  const rest = nodes
    .filter((n) => n.uri !== rootUri && !emitted.has(n.uri))
    .sort((a, b) => a.time - b.time || (a.uri < b.uri ? -1 : 1));
  for (const node of rest) out.push(node.item);
  return out;
}
