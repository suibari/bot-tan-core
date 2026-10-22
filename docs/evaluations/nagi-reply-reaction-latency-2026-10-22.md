# Nagi 返信・リアクションの所要時間

2026-10-22 20:30 JST 頃、本番DBを読み取り専用で集計。直近24時間で、
AI返信が初回試行で投稿され、同じ投稿への自動リアクションも成功した43件。
公開投稿を作るベンチマークは実施せず、実際の処理の記録を使用した。

| 処理 | 平均 | 中央値 | p95 |
| --- | ---: | ---: | ---: |
| 返信 | 13.296秒 | 11.497秒 | 22.089秒 |
| リアクション | 5.426秒 | 3.861秒 | 13.092秒 |

返信は `bot_reply_jobs.updated_at - mode_decided_at`、リアクションは
`bot_auto_reactions.updated_at - scheduled_at`。返信の計測には生成方式の決定後の
コンテキスト収集・生成・投稿・ジョブ完了更新が入る。リアクションには候補取得・
生成・PDS書き込み・台帳更新が入り、その後のAppView取り込みは含まない。
どちらも投稿受付からの待ち時間ではない。索引待ちなど、計測開始前の処理も含まない。
返信完了からリアクション開始までの平均は0.209秒だった。

両経路は Ollama を使用するため、並列時の高速化はこの計測では保証できない。
短いリアクションを返信前に完了させる順序へ変更する。返信が失敗しても、
リアクションは独立して返せる。再試行時の重複は既存のリアクション台帳で防止する。
会話ターン・こっそり・削除済み・ミュート・既存リアクションの除外は維持する。
ゼンカツの総評経路は今回の変更対象外。

変更後は `nagi-auto-reaction` の `finished.elapsedMs` と
`nagi_reply_posted.elapsedMs` / `nagi_reply_failed.elapsedMs` で個別の所要時間を記録する。
前者は索引待ち・AppView取り込みまで、後者はリアクション完了後から
返信ジョブの完了更新までを測るので、上表と計測区間が異なる。

集計SQL（再実行時点からの直近24時間）:

```sql
select count(*) as n,
  avg(extract(epoch from(j.updated_at-j.mode_decided_at))) as reply_mean_s,
  percentile_cont(0.5) within group
    (order by extract(epoch from(j.updated_at-j.mode_decided_at))) as reply_median_s,
  percentile_cont(0.95) within group
    (order by extract(epoch from(j.updated_at-j.mode_decided_at))) as reply_p95_s,
  avg(extract(epoch from(r.updated_at-r.scheduled_at))) as reaction_mean_s,
  percentile_cont(0.5) within group
    (order by extract(epoch from(r.updated_at-r.scheduled_at))) as reaction_median_s,
  percentile_cont(0.95) within group
    (order by extract(epoch from(r.updated_at-r.scheduled_at))) as reaction_p95_s,
  avg(extract(epoch from(r.scheduled_at-j.updated_at))) as gap_mean_s
from nagi.bot_reply_jobs j
join nagi.bot_auto_reactions r on r.subject_uri=j.source_uri
where r.created_at>now()-interval '24 hours'
  and r.kind='post' and r.state='reacted'
  and j.state='posted' and j.attempts=1 and j.generation_mode='ai'
  and j.mode_decided_at is not null;
```
