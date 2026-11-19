# 検索・Wikipediaの共通出口（2026-09-27、2026-11-19 に Web 検索 API へ切り替え）

本番は `192.168.1.200:8080` の共通APIだけを使う。bot-tan-calender（220）も200へ接続する。
Web 検索は **SearXNG ではなく、Web 検索 API の毎月の無料枠**で引く（Tavily → Exa lite）。
経緯は末尾の「SearXNG をやめて Web 検索 API へ（2026-11-19）」。

```mermaid
flowchart LR
  B[Bluesky / Nagi / リサーチ] --> G[200 共通出口API]
  C[220 calendar] --> G
  G --> Q[共有キュー・キャッシュ・1日の上限]
  Q --> S[Web 検索]
  Q --> W[Wikipedia 記事・カテゴリ取得]
  S --> E[Tavily / Exa lite]
```

## APIと制御

- `GET /search?format=json&q=...`: 応答は SearXNG の JSON の形（`results` / `infoboxes` /
  `unresponsive_engines`）。`provider` に答えた API の名前が入る。`engines=` に API の名前
  （`exa,tavily`）を並べるとその順に使う。SearXNG のエンジン名（`yahoo` など）は無視する。
- `GET /wikipedia/ja?action=query&format=json&...`: Wikipediaの読取専用API。
  言語部分は `en` 等も可。記事本文、検索、カテゴリ一覧だけを許可する。任意URLは受け付けない。
  **Web 検索の無料枠を使わない。**
- `GET /stats`: 呼び出し元別の件数、キャッシュ、共有、上流実行、混雑、429待機、
  `budget`（API ごとの今日の使用量と上限）を確認する。
- `GET /healthz`: gateway 自身の生存のみ。API は呼ばない。

healthz以外は `Authorization: Bearer <SEARXNG_API_KEY>` が必要。
クライアントの `X-Search-Source` は観測用で、キャッシュを分割しない。

検索とWikipedia取得を同じワーカーで直列化し、完了から次の開始まで `SEARCH_GATEWAY_INTERVAL`
（既定0.3秒）空ける。SearXNG の頃はスクレイピングを控えめにするため1秒だったが、API と
Wikipedia には要らず、その場調べの5秒の締め切りに Wikipedia と Web の両方を収めるために縮めた。
同一URL（パラメータ順とqの前後空白を正規化）の進行中要求は共有する。
応答は最大256件・合計16MiBまでキャッシュする。検索は6時間（`SEARCH_CACHE_TTL`）、
Wikipedia記事は6時間。HTTPエラー、不正JSON、Wikipedia APIエラーは成功キャッシュへ入れない。

未完了の異なる要求は最大8件、キュー待ちは最大10秒、上流タイムアウトは15秒。
期限切れの仕事は上流へ送らず503とする。呼び出し側のタイムアウトは30秒にする。
HTTP待機スレッドも32本までに制限する。

### 1日の上限（無料枠）

API ごとの上限は月の無料枠÷31。Tavily 1,000回 → 32回、Exa は $10 を lite（抜粋込みで1回 $0.004、
2026-11-19 実測）で使って 80回。`TAVILY_DAILY_LIMIT` / `EXA_DAILY_LIMIT` で変えられる。
使った回数は `searxng/data/budget.json` に残り、再起動してもその日の残りは増えない。日付は0時（JST）で替わる。

- 先頭の API の枠が尽きたら次の API へ回る。API が「上限超過」（401/402/403/432/433）を返したら
  その日は閉じる。通信エラーや 5xx は請求されないので枠を返す。
- 全部尽きたら、翌0時まで `/search` は即座に 429 を返す（キャッシュにあれば返す）。
  この 429 は出口全体の休止を起こさないので、**Wikipedia API は止まらない**。
- 呼び出し側は通常の検索失敗として扱う。その場調べは Wikipedia の材料だけで返信し、
  知識カードは「検索がまともに行えなかった」として後で再試行する。

上流の 429（Retry-After、最大1時間、指定なしは180秒）と Wikipedia の ratelimited / maxlag（180秒）は、
従来どおり出口全体を休ませる。新規の未キャッシュ要求は429になるため、呼び出し側は通常の取得失敗として扱い、
直接接続や即時再試行で迂回しない。待機中の要求も10秒を超えたら破棄する。

キュー・キャッシュ・休止状態は単一プロセスのメモリ内（1日の使用量だけはファイル）。
**gatewayを複数台/複数プロセスで起動しない**。

## 接続設定

`searxng/.env`:

```dotenv
SEARCH_GATEWAY_API_KEY=<openssl rand -hex 32で生成>
SEARCH_GATEWAY_BIND=192.168.1.200
SEARXNG_PORT=8080
WEB_SEARCH_PROVIDERS=tavily,exa
TAVILY_API_KEY=<Tavily のキー>
EXA_API_KEY=<Exa のキー>
```

両PJの `.env`:

```dotenv
SEARXNG_BASE_URL=http://192.168.1.200:8080
SEARXNG_API_KEY=<上のSEARCH_GATEWAY_API_KEYと同じ値>
SEARXNG_ENGINES=yahoo,bing,wikipedia,wikidata   # SearXNG 時代の名残。gateway は無視する
```

bsky側は `SEARXNG_TIMEOUT_MS=30000`、calendar側は `SEARXNG_TIMEOUT_S=30`。
LAN外へ公開しない。キーはログやコマンド引数へ出さない。
`scripts/deploy.sh` は毎回 `scripts/deploy-searxng.sh` を実行し、Git差分の有無にかかわらず
gatewayのイメージをpullする。新イメージがあればComposeが更新する。
`searxng/` または更新スクリプトに差分があれば、bind mountの変更も反映するため再作成する。
変更がなければ稼働中コンテナを維持する。更新後はhealthcheckを待ち、版とimage IDを記録する。
pull失敗時は再作成せず、他appsのデプロイを続行した後、全体を非ゼロで終了する。
再試行は `bash scripts/deploy-searxng.sh --force-recreate` で行える。
これはデプロイ時の更新であり、デプロイが無い期間に自動更新するタイマーではない。

切り替え時はAPIと利用側を一緒に更新する。APIだけ先に認証必須化すると旧クライアントが401になる。
旧env・コミット・コンテナimage IDを控え、200側を先に更新、続いてcalendarを更新して疎通確認、
最後に220側の `nagi-searxng` の再起動ポリシーを無効化して停止する。
ロールバックもAPIと両クライアントの接続設定を一組で戻す。

## 検索量の整理

| 呼び出し元 | 処理 |
|---|---|
| grounding | 重複・空クエリを除去。最大4クエリを順番に依頼し、一度にキューを占有しない |
| knowledge-card | 対象名の1検索 |
| Nagiラジオ | 確認済みAnimeThemes出典があれば0検索。それ以外は背景調査を最大2検索 |
| Nagi候補選定 | 曲リンク不成立のみ再選定。背景が見つからないだけでは別の曲を引き直さない |
| 題材選曲 / キャラ調査 | 共通APIへ依頼し、横断キャッシュと進行中要求の共有を利用 |
| 本文取得 | Wikipedia記事は共通APIへ。それ以外は従来のSSRF検証付き本文取得 |
| calendar | SearXNGとWikiClientの両方を共通APIへ。独自のsleep/ロック/記事キャッシュは撤去 |

これまではNagiラジオの背景調査が4クエリ×3候補で最大12検索だった。
`engines=...` と `categories=general` の併記はSearXNGの実装上、カテゴリ全体を
追加検索する。gatewayでこの併記を解消し、エンジンを絞ったプローブも正しく送信先を限定する。

## Bing調査の結論と限界

9月2日の記録では一覧・時事検索は正常。200側はその日に作成したコンテナのままで、
9月27日の調査ではBingの検索語無視/無関係な結果を確認した。

- `MINMI Who's Theme`: 歌手の一般情報だけ、またはGoogle Maps等の無関係な結果。
- `ROOKiEZ is PUNK'D IN MY WORLD`: Windows、Netflix等の無関係な結果。
- `米津玄師 Lemon`: 曲を絞れず歌手の一般情報が上位。
- 一方「秋アニメ」の一覧検索とWikidataの「初音ミク」の要約は機能した。

本番コンテナ内でBingへ直接問い合わせ、HTMLの検索欄にはクエリ全文が存在し、
検索結果のh2は既に無関係だった。SearXNGの解析結果はそのh2と一致した。
したがって、今回の再現はアプリでのクエリ欠落やSearXNGのタイトル抽出ミスではない。

上流には同症状の [issue #4964](https://github.com/searxng/searxng/issues/4964) と、
9月11日にマージされた [修正 #6671](https://github.com/searxng/searxng/pull/6671) がある。
旧mkt指定と修正版のsetlang/cc指定を2秒以上空けて比較しても、本番回線では改善しなかった。
さらに220側の検証用 `2026.9.25-12f8b6515` でも同じ曲検索の異常を再現した。
220側の既存SearXNGも9月22日版だったため、200側の版の古さだけでは説明できない。

9月27日、本番の共通API経由で更新後の `2026.9.25-12f8b6515` を再検証した。
`MINMI Who's Theme` は四工大の進学記事、`ROOKiEZ is PUNK'D IN MY WORLD` は
別人の成人向けページが上位に出た。言語を英語に変え、曲名を引用符で囲み、作品名を
追加しても、ホテルやGoogle Maps等の無関係な結果になった。いずれもHTTP 200で
`unresponsive_engines` は空なので、応答の成否や件数だけでは異常を検知できない。
一方、同じ出口・同じエンジンで `秋アニメ 2026` はアニメ一覧5件、
`薬屋のひとりごと` は公式サイトやWikipedia記事を返した。

WikipediaのSearXNGエンジンは作品名の要約には有効だが、`秋アニメ 2026` では
結果も要約も0件。共通APIのWikipedia検索 (`/wikipedia/ja`, `list=search`) では
`IN MY WORLD` 等の関連項目を見つけられるが、秋アニメの一覧は得られなかった。
したがってBingを全経路から外してWikipediaだけにすると、今期作品などの一覧調査が
退行する。Bingは一覧・作品名には当面残し、曲の背景調査はBing結果の関連性を
検証して採用する。曲名検索の解決を要する場合はWikipedia検索APIを経由して
出典のある記事だけ使う方針とし、単に検索回数を増やす対応はしない。

**頻度制御や最新版への更新だけでBingが復旧したとは扱わない。**
Bing側の地域・接続元・応答制御のどれが原因かまでは未確定。
背景情報が無いときに捏造したり検索回数を増やしたりせず、出典のある素材だけを利用する。
`pnpm searxng:probe -- --query="MINMI Who's Theme"` 等で件数に加えてタイトルと本文の関連性を見る。

## 10月7日の再調査: Yahooを主索引にする

本番のSearXNGは `2026.10.4-d48c4b555`。本番回線から、本番コンテナとは別の使い捨て
コンテナで各エンジンを個別に確認した（クエリ間3秒）。

| エンジン | 結果 | 上流issue |
|---|---|---|
| yahoo | ✅ 6クエリ全てで関連結果（7件）。曲名も一覧も取れる | — |
| bing | △ `ROOKiEZ is PUNK'D IN MY WORLD` は早稲田大学の質問、`技術書典` は韓国ドラマの記事。他4件は正常 | [#4964](https://github.com/searxng/searxng/issues/4964)（修正済みとされる） |
| duckduckgo | △ `秋アニメ 2026` でCAPTCHA。他は結果あり | [#6779](https://github.com/searxng/searxng/issues/6779)、[#6596](https://github.com/searxng/searxng/issues/6596) |
| brave | ❌ 初回から too many requests | [#6819](https://github.com/searxng/searxng/issues/6819) |
| google | ❌ access denied | — |
| qwant | ❌ 全クエリCAPTCHA | [#3929](https://github.com/searxng/searxng/issues/3929)、[#6358](https://github.com/searxng/searxng/issues/6358) |
| startpage / mojeek / presearch | 未確定（設定で有効化しても読み込まれず、`engines=` 指定が無視された） | startpageは [#6520](https://github.com/searxng/searxng/issues/6520) |

Braveは#6819で、IPブロックではなく `brave.py` が付ける `Accept-Encoding: gzip, deflate` と
curl_cffiのChrome偽装の組み合わせで429になる、という分析がある。上流の修正後に再評価する。

**`engines=` に読み込まれていないエンジン名だけを指定すると、SearXNGはエラーにせず
既定エンジンの結果を返す。** エンジンを絞って測るときは、件数ではなく各結果の
`engine` / `engines` を見ること。

Yahooを足すだけでは、Bingの無関係な1位が上位5件に残った。SearXNGのスコアは
エンジンの `weight ÷ 順位` の和なので、`settings.yml` でYahooを `weight: 10` にした。
Yahooの7位（10/7）もBingの1位（1）より上になり、Bingは補完に回る。
同じ6クエリで上位6件から無関係な結果が消えた。レイテンシはBing単独の約0.9〜1.6秒に対し、
併用でも約0.8〜1.3秒で増えなかった（エンジンは並列に問い合わせる）。

YahooもBingの索引を使うので、索引の多様化ではない。Bingの取得・解析経路の異常を
迂回できる冗長化として扱う。Yahooが詰まった場合はBingの結果だけが残るので、
引き続き件数ではなく関連性で監視する。

クライアントは `engines=` を明示して送るため、`SEARXNG_ENGINES` を設定している環境は
`yahoo` を足さないと反映されない（本番の `.env` とcalendar側も同様）。

## IPv4 での汚染と IPv6 への切り替え（2026-11-07〜08）

10/07 の時点では正常だった Yahoo が、11月初めには SearXNG 経由でクエリと無関係な結果を
返すようになっていた（「超融合」→ アパートの間取り、「Puella Magi」→ TJ Maxx など。他人の
検索のような中身）。HTTP 200・応答しないエンジン無し・件数もそろうので、healthz では気づけない。
知識カードはこれを材料に作られ、「トリシューラ＝シヴァ神の槍」のようなジャンル違いが返信に混ざった。

切り分けの結果（評価用の27語、SearXNG 2026.11.6）:

| 条件 | Yahoo の関連あり |
|---|---|
| IPv4（自宅 NURO 111.216.178.97、docker のブリッジ） | 13/27（偽の結果・HTTP 500 `INKApi Error`・0件） |
| IPv6（同じ機械、ホストのネットワーク） | 24/27 |
| IPv6（docker のブリッジで IPv6 を有効にしたもの） | 25/27 |

- SearXNG を通さず素の Python で叩いても、IPv4 なら汚染され IPv6 なら正常。SearXNG の版
  （9月版・最新版とも同じ）やブラウザ偽装の有無は関係ない。
- 9月から同じ IPv4 で1日300回前後スクレイピングしてきたので、上流にボットとして目を付けられたと
  見ている（確証はない）。検索の8割は「見つからない」の再試行と文の形の語で、量を絞ってから
  IPv6 へ移した（調査は1日約300 → 約60回）。
- Bing は IPv4 / IPv6 とも同じで、日本語クエリの頭の一語だけで検索する（「トリシューラ」→「トリ」、
  「メイドインアビス」→「メイド」）。パラメータを全部外しても、クッキーを持たせても変わらない。
  上流の #6671 と同じ症状で、日本語では直っていない。

対策:

- `compose.yml` の既定ネットワークで IPv6 を有効にし（ULA ＋ Docker の NAT66）、`settings.yml` の
  `outgoing.source_ips` を `::` に固定した。IPv6 が使えないときは IPv4 へ黙って戻らず失敗する。
- ネットワークの設定は `compose up` では作り直されないので、`deploy-searxng.sh` が既存のネットワークの
  IPv6 を見て、無効なら一度 `down` してから `up` する。デプロイの最後に外向きのアドレスを表示する。
- 中身の監視は `apps/biorhythm_server/src/searxngRelevance.ts`（6時間ごと、エンジンごとに決まった語を
  検索して上位3件を見る）。ダッシュボードの Web 検索タイルに「検索結果の関連性」として出る。
  IPv6 も量が増えれば同じことになりうるので、ここが stale / down になったら量と経路を見直す。
  timeout など答えが返らなかった語は「無関係」に数えず、SearXNG の Suspended が解ける15秒後に
  1回だけ引き直す（それでも答えなければ「確認できず」として判定から外し、全部そうなら unknown）。
  too many requests / CAPTCHA / access denied / gateway の 429 は制限として外れに数える。
  2026-11-09 の down 2回は、1語目の timeout で Yahoo が Suspended になり残り2語が巻き添えで
  0件になった誤報だった。

## SearXNG をやめて Web 検索 API へ（2026-11-19）

IPv6 へ移したあとも、11/14 02:54 JST から関連性監視が落ち始め、11/14 22:18 以降は Yahoo が
ずっと無関係な結果を返した（「葬送のフリーレン」→「Walmart Supercenter」など）。知識カードの
「関連あり」は 11/08〜13 の 49〜90% から 4〜16% に落ちた。SearXNG を通さず curl で叩くと、
本番機は IPv4 / IPv6 とも HTTP 500。開発機（同じ IPv4、IPv6 も同じ /64）は最初の数回だけ正常で、
約20回で 500 に変わった。アドレス1つではなく /64 か回線全体が目を付けられたと見ている。
IPv6 化と同じ 11/08 にその場調べの Web 検索も入り、gateway の検索は1日330〜400回あった。

同じ回線からスクレイピングする限り繰り返すので、Web 検索 API に替えた。比較
（`pnpm search-api:compare`、結果は `docs/evaluations/search-api/`）:

| API | 語だけ | 語＋文脈語 | 応答 | 毎月の無料枠 | 結果の保存 |
|---|---|---|---|---|---|
| Brave | 31/32 | 32/32 | 0.58秒 | 約1,000回 | 規約 §3(b)(i) で一時的な保存以外は禁止 |
| Tavily | 29/32 | 31/32 | 1.3秒 | 1,000回 | 禁止する条文なし |
| Exa lite | 22/32 | 32/32 | 0.28秒 | 約2,500回 | §4.2(a) は定型の広い禁止（API にも文字どおり当てはめると使えない） |
| Serper | 29/32 | 30/32 | 1.4秒 | 補充なし（初回2,500回だけ） | — |

無料のまま続ける方針なので Serper は外した。知識カードは結果から作った要約を DB に残すので、
Brave は使わない。Tavily を先、Exa lite を後にする。ただしその場調べは5秒の締め切りがあるので、
`engines=exa,tavily` で速い Exa lite を先にする（必ず「語 ジャンル」で引くので、Exa lite でも32/32）。

無料枠（1日約110回）に収めるため、量も減らした。

- Nagi ラジオの曲の豆知識は Web 検索をやめ、Wikipedia の全文検索だけにした（1日約120回）。
- 関連性の監視（`searxngRelevance.ts`）は削除。API は汚染されないので要らない。
  ダッシュボードの Web 検索タイルには、代わりに今日の使用量（「検索の無料枠」）を出す。
- その場調べと知識カードは Wikipedia を先に引き、取れなかった語だけ Web 検索へ回す。
  その場調べの Web 検索はプロセスごとに1日30回まで（`AI_LIVE_RESEARCH_WEB_DAILY`）。

## 検証

```sh
python3 -B -m unittest discover -s searxng -p 'test_*.py' -v
```

独立したクライアントプロセスからの検索/Wikipedia混在リクエストで実時間の間隔を確認する。
キャッシュ、進行中共有、期限切れ破棄、上限、429、認証、許可先の限定、1日の上限（翌日の戻り・
再起動をまたいだ保持・上限超過で閉じる・通信エラーで返す）、API の切り替えもテストする。
