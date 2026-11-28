# Nagi の個人データを ATproto Spaces へ移す計画

2026-11-28 作成。Spaces は 2026-12-01 に β リリースの予定。
**この計画に沿った PR は、β を実機で確認してからオーナーがマージする。** それまではマージしない。

仕様の出典は [AT Protocol Spaces Field Guide](https://atproto.how/atproto-spaces-field-guide)（2026-11-26 改訂版）と、
lexicon 正本の `bluesky-social/atproto` `permissioned-data` ブランチ（`lexicons/com/atproto`）。
ガイドには β の範囲、`@atproto/pds` の対応バージョン、Bluesky 公式 PDS の対応時期が**書かれていない**。
この計画はそこを前提にせず、未対応 PDS が長く残ることを前提に組んでいる。

---

## 1. 結論

- **置き場所は personalspace を1ユーザ1つ。** space type は `com.suibari.nagi.private`、skey は `self`。
  ガイドが personalspace の例に挙げているのが、まさにブックマーク・ミュート・下書き。
  Nagi AppView しか読まないので、種別ごとに space を分けても credential と同意の手間が増えるだけ。
- **AppView の既存テーブルは消さずにキャッシュとして残す。** タイムラインのミュート除外、
  ホームの非公開リスト、Push の通知設定、botたんの呼び名などはサーバ側で引く必要があり、
  Spaces でもアプリは自前の syncer（コピー）を持つ前提になっている。読み取りクエリはほぼ変わらず、
  変わるのは「書き込み経路」と「取り込み（PDS → テーブル）」だけ。
- **ユーザごとに保存先を切り替える二重運用にする。** 本番の Nagi ユーザ 69人のうち 53人が
  bsky.network（Bluesky の PDS）にいる。Bluesky の PDS が β 初日に Spaces を有効にする保証はないので、
  「対応 PDS のユーザだけ任意で移る」形にし、AppView 保存の経路はしばらく残す。
- **データは少ない。** 移行対象は全部で約 700 行（最大でも 1 人 1 テーブル数十行、下書きの最大 11KB）。
  データ量より、認可と同期の仕組みを作るほうが規模の大半を占める。

---

## 2. 対象データの棚卸し

本番の件数は 2026-11-28 に読み取りのみで確認した。

### 2.1 Space へ移すもの

本人が決めて、本人だけが見る設定・一覧。PDS が正本になっても AppView の判断が要らないもの。

| テーブル | 行数 / 人数 | space の collection | rkey |
|---|---|---|---|
| `mutes` | 10 / 5 | `com.suibari.nagi.private.mute` | 対象の正規形の sha256（base32） |
| `private_list_members` | 71 / 24 | `com.suibari.nagi.private.listMember` | メンバーの DID |
| `bookmark_folders` | 68 / 63 | `com.suibari.nagi.private.bookmarkFolder` | 既存の UUID |
| `bookmarks` | 16 / 6 | `com.suibari.nagi.private.bookmark` | 既存の UUID |
| `drafts` | 8 / 3 | `com.suibari.nagi.private.draft` | 既存の UUID |
| `bookmark_preferences` | 38 | `com.suibari.nagi.private.bookmarkPreferences` | `self` |
| `language_preferences` | 4 | `com.suibari.nagi.private.languagePreferences` | `self` |
| `moderation_preferences` | 8 | `com.suibari.nagi.private.moderationPreferences` | `self` |
| `notification_preferences` | 5 | `com.suibari.nagi.private.notificationPreferences` | `self` |
| `diary_day_preferences` | 34 | `com.suibari.nagi.private.diaryDay` | `self`（本人が選んだ値だけ） |
| `emoji_favorites` | 69 | `com.suibari.nagi.private.emojiFavorites` | `self` |
| `tag_favorites` | 2 | `com.suibari.nagi.private.tagFavorites` | `self` |
| `feed_tabs` | 11 | `com.suibari.nagi.private.feedTabs` | `self` |

設定は**今のテーブルの分け方のまま、1テーブル1レコード**にする。space の `putRecord` には
`swapRecord` が無いので、複数の設定を1レコードにまとめると、別々の端末が別々の設定を
変えたときに後から書いたほうが丸ごと勝ってしまう。各レコードは `updatedAt` を持ち続け、
クライアントの後勝ちの判定はそのまま使う。

`diary_day_preferences` のうち、ブラウザから毎回自動で届くタイムゾーン（`detected_timezone`）は
AppView に残す。space に置くのは本人が選んだタイムゾーンと区切りの時刻だけ。

### 2.2 AppView に残すもの

| テーブル | 残す理由 |
|---|---|
| `card_instances` / `zenny_*` / `card_draws` 系 | 改竄防止のため AppView が権威（既存コメントの判断のまま） |
| `notifications` / `reaction_notice_ledger` | AppView が生成するもの。台帳は消してはいけない |
| `push_subscriptions` | 端末ごとの宛先と capability の秘密。サーバから送るのでサーバに置く |
| `age_assurance` | 法令対応の記録。本人が書き換えられてはいけない |
| `preferred_names` | `source = declared` は**botたんが会話から書く**。AppView は本人の PDS へ書く権限（OAuth）を持たないので、正本を移せない。設定画面の入力（`manual`）だけ移すと出所が二つになるため、まとめて残す |
| `diary_day_schedules` | AppView が設定から導出する履歴。過去の区切りを固定する役割なので本人が書き換えられると困る |
| `actor_analyses` / `actor_interest_*` / `chronicle_events` 等 | AppView が生成した派生データ。本人のエクスポート対象にはするが、正本は AppView |
| モデレーション・ジョブ・埋め込み | 運営側のデータ |

### 2.3 判断を保留するもの（初回は移さない）

`read_positions`（186 行）、`chronicle_read_years`、`advent_read_states`、`radio_read_states`。

既読位置はスクロールのたびに書かれる。Spaces では書き込み1回が「PDS の commit → space host への通知 →
AppView の pull」になり、今の単調更新（巻き戻らない upsert）を PDS の後勝ちで再現するのも手間がかかる。
失っても困らない情報でもあるので、本体の移行が安定してから測って決める。

---

## 3. 仕組み

### 3.1 登場人物

| 役割（ガイドの用語） | Nagi での担当 |
|---|---|
| Space authority | ユーザ本人の DID |
| Repo host / Space host | ユーザ本人の PDS（personalspace なので同じ PDS） |
| Syncer | Nagi AppView |
| 書き手 | Nagi クライアント（ブラウザ。本人の OAuth セッションで書く） |

### 3.2 書き込み

```
クライアント ──OAuth──▶ 本人のPDS  com.atproto.space.putRecord / applyWrites / deleteRecord
     │
     └──service auth──▶ AppView  com.suibari.nagi.syncPrivateSpace { delegationToken }
                              │
                              └─▶ 本人のPDS  listRepoOps(since) → テーブルへ反映
```

- AppView は OAuth セッションを持たない（クライアントは `token_endpoint_auth_method: none` の
  ブラウザ公開クライアント）。**書くのは常にクライアント。**
- 書いた直後に AppView の `syncPrivateSpace` を叩いて即時に取り込ませる。Jetstream を待たない
  `ensureNagiBotRecordIndexed` と同じ考え方で、ミュートした直後のタイムラインに反映させるため。
  space host からの `notifySpaceUpdate` は、ほかの端末やほかのアプリが書いたときの回収経路。
- 移行済みユーザに対しては、従来の書き込み API（`setMute`、`putPreferences` など）が
  `409 moved_to_private_space` を返す。古いタブが AppView 側だけに書いて、PDS と分岐するのを防ぐ。

### 3.3 AppView の credential

1. クライアントが本人の PDS で `com.atproto.space.getDelegationToken` を取る（60秒・1回限り）。
2. AppView へ渡す。AppView は自分の P-256 鍵（`credentialKey`）を添えて
   `com.atproto.space.authorizeSpaceSync` を呼び、space credential（既定10分・最長60分）と
   通知の登録（`notify`）を得る。
3. credential の期限内は、通知が来たら AppView が自分で pull できる。
4. **期限が切れたら、AppView だけでは更新できない。** 次にクライアントが開いたとき
   （起動時・復帰時・書き込み時）に delegation token を渡してもらう。

4 は制約だが、Nagi の私的データを書くのはほぼ Nagi クライアントなので、書いた本人が
オンラインのうちに取り込める。Push の通知設定やタイムラインのミュートは AppView のコピーを読むので、
オフラインのあいだも動く。

- personalspace の policy にはフィールドが無く `allowedApps` も無いので、client attestation
  （JWKS 鍵の署名）は要らない見込み。**要ると分かった場合はブラウザ公開クライアントでは作れず、
  機密クライアント（BFF）化が必要になる。** β で最初に確かめる項目（5章）。
- AppView の credential 鍵は `NAGI_SPACE_CREDENTIAL_KEY`（P-256、秘密）として持つ。漏れても
  delegation token が無ければ新しい credential は取れないが、取得済み credential は期限まで使える。

### 3.4 取り込み

- `listRepoOps(since)` を `cursor` が尽きるまで辿り、LtHash で `commit.data` と突き合わせる。
  一致しなければ `getRepo`（STAR）で全件取り直す。PDS 移行後も op log が空になるので同じ経路で回復する。
- 各レコードは既存の `validateRecord.ts` と同じ考え方で検証し、通らないものは取り込まない
  （今は AppView の API が入口で検証しているが、PDS が正本になると任意の値が書けるため）。
- 既存テーブルに `space_rkey` / `space_cid` を足し、どのレコード由来かを持たせる。
  同期状態は `nagi.private_spaces` に列を足して持つ（最後の rev、LtHash、
  credential の期限、通知の登録 token）。
- 通知の受け口は `POST /xrpc/com.atproto.space.notifySpaceUpdate` と `confirmRegistration`。
  通知は token 以外の認証が無く、データも載っていないので「pull のきっかけ」以上には信じない。
  `#spaceDeleted` は `authorizeSpaceSync` で `SpaceDeleted` を確かめてからコピーを消す（ガイドの指示）。
- 定期回収は `startWorkerLoop` で回す（AGENTS.md）。即時起動の口（`syncPrivateSpace`）があるので、
  間隔は分単位でよい。

### 3.5 保存先の判定

新テーブル `nagi.private_spaces` の `storage`（`appview` | `migrating` | `space`）で持つ。行が無い人は `appview`。`nagi.actors` は取り込み用の表で行が無いログインユーザもいるので使わない。
読み取りはどちらでも同じテーブルを見るので、判定が要るのは書き込み API と取り込みだけ。

PDS の Spaces 対応は、ガイドに検出方法の記載がない。クライアントが `com.atproto.space.listSpaces` を
呼び、`MethodNotImplemented` / 404 / 501 なら未対応とみなす。結果は端末にだけ覚え、
一定期間ごとに再確認する（PDS の更新で対応することがあるため）。

### 3.6 OAuth スコープ

`space:com.suibari.nagi.private?manage=create`（`action` は既定の read/create/update/delete）。

- ガイド 8章の例は bare の `space:<type>` で space を作っているが、9章では `createSpace` に
  `manage=create` が要るとしており食い違っている。β の実装で確かめ、要るほうに合わせる。
- 既存の permission-set `com.suibari.nagi.appviewAccess` に `include` で足すと、全員に再同意が要り、
  認可サーバのキャッシュも最大24時間残る。**permission-set には入れず、既存のオプトイン機構
  （`src/lib/optin/scope-optin.ts`。クロスポストと同じ）で、移行を選んだ人にだけ追加で求める。**
- personalspace の読み手は「本人のアカウント経由で認可したアプリ」に限られ、scope の外で絞る手段は無い。
  同意画面には space type の `title`（「Nagi の非公開データ」）が出る。

---

## 4. データ移行の手順

ユーザが設定画面から「非公開データを自分の PDS へ移す」を選んだときに、クライアント主導で行う。
読み込み中はスピナーを出す。

1. **対応確認**：`listSpaces` で PDS の対応を確かめる。未対応なら理由を表示して終わる。
2. **同意**：`space:` スコープの追加で再サインインする（オプトインの保留フラグ → 戻ってから続行）。
3. **開始**：AppView の `com.suibari.nagi.beginPrivateSpaceMigration` で `storage = migrating`
   にする。この間、従来の書き込み API は `423` を返し、クライアントは書き込みを待たせる。
4. **作成**：`com.atproto.space.createSpace`（personalspace policy、skey `self`）。既にあれば流用。
5. **書き出し**：AppView の `com.suibari.nagi.exportPrivateData` で 2.1 の行を受け取る。
6. **書き込み**：`applyWrites` で分けて書く（1回あたりの上限はガイドに記載が無いので、
   最初は50件で区切り、β で測って調整）。rkey が決まっているので、途中で失敗しても
   やり直せば同じレコードに上書きされる。
7. **照合**：delegation token を渡して `syncPrivateSpace`。AppView が全件取り込み、
   移行前の行とコレクションごとの件数・内容のハッシュを比べる。
8. **切り替え**：一致したら `storage = space`。一致しなければ `appview` に戻し、
   書いた space はそのまま（次回の再試行で上書きする）。

**戻す手順**：AppView にコピーが残っているので `storage = appview` に戻せば従来どおり動く。
PDS 側の space は本人の持ち物なので AppView からは消さない（消すならクライアントが `deleteSpace`）。

**アカウント削除**：`deleteAccountData` は AppView のコピーと同期状態を消す。本人の PDS の space は
本人のデータなので残す（設定画面で `deleteSpace` も選べるようにする。`manage=delete` が要る）。
authority のアカウントが消えると space も消え、AppView は firehose の `#account` で知る。

### 4.1 取り込みで扱う既知の注意点（β 後の取り込みワーカーで対応）

- `drafts.id` と `bookmark_folders.id` は全ユーザで一意の UUID。space のレコードは本人が任意の rkey を
  書けるので、他人の行と同じ UUID を持ち込まれる可能性がある。取り込みは所有者が違う行を上書きせず、
  そのレコードを飛ばす。
- 他のユーザがアカウントを消すと、`deleteAccountData` は全員のミュート・非公開リストからその DID を消す。
  移行済みの人の space にはレコードが残るので、次の全件取り込みでコピーに戻る。表示上の害は無い
  （消えたアカウントの投稿は出ない）が、取り込み側で存在しないアカウントを数えないようにする。

---

## 5. 実現性の確認項目（β 初週に確かめる）

| # | 確認すること | だめだった場合 |
|---|---|---|
| 1 | Bluesky の PDS（bsky.network）が β で Spaces を有効にするか。11/28 に認証なしで叩いた時点では、認証の要らないはずの `authorizeSpaceSync` も存在しないメソッドと同じ `401 AuthMissing` を返した（未知のメソッドを AppView へ回す経路に落ちている可能性が高い）。β 後に試験アカウントの OAuth で `listSpaces` を呼んで確かめる | 自前 PDS などのユーザだけで始める。ユーザの大半（53/69）は当面 AppView のまま |
| 2 | personalspace の `authorizeSpaceSync` に client attestation が要らないか | 要るなら BFF 化が先。計画を作り直す |
| 3 | `createSpace` に `manage=create` が要るか | scope の文字列を合わせる |
| 4 | credential を delegation token 無しで延長できるか | できないなら 3.3 のとおり、クライアントが開くたびに渡す |
| 5 | `applyWrites` の件数・サイズ上限、レート制限 | 分割数を調整 |
| 6 | TypeScript の参照実装（`@atproto/space`、`@atproto/pds`）が npm に出るか | LtHash・HTTP Message Signatures を自前実装する（規模 +30%） |
| 7 | 試験 PDS で一連の流れが通るか | 試験 PDS（Tranquil）は Spaces 未対応の可能性が高く、Tranquil 本体は改変しない方針。開発機で `permissioned-data` ブランチの `@atproto/pds` か `atproto-pds`（Rust）を立てて試す |

---

## 6. 変更規模

| 場所 | 内容 | 見積もり |
|---|---|---|
| `packages/nagi-lexicon` | space type 宣言、record lexicon 7本、XRPC 4本（`syncPrivateSpace` / `beginPrivateSpaceMigration` / `exportPrivateData` / `getPrivateSpaceStatus`）、型生成 | 約 400 行 |
| `packages/database` | `private_spaces`（保存先と同期状態）、対象テーブルへ `space_rkey` / `space_cid`、マイグレーション | 約 250 行 |
| `apps/nagi_appview` 新規 `spaces/` | space XRPC クライアント（credential 署名ヘッダ付き）、credential 管理、LtHash、取り込みワーカー、通知の受け口、コレクションごとの対応付けと検証 | 約 1,800 行（参照実装が使えれば約 1,200 行） |
| `apps/nagi_appview` 既存 | 書き込み API の保存先ガード、`deleteAccountData`、エクスポート | 約 300 行 |
| テスト | 対応付け・検証・照合・ガード・ワーカー・通知 | 約 1,200 行 |
| `nagi_client`（別リポジトリ） | オプトイン、space 書き込みアダプタ、ミュート・非公開リスト・ブックマーク・下書き・設定・お気に入りの各ストアの二重経路、移行画面 | 約 1,800 行 + テスト |

合計でおよそ 5,500〜6,000 行。PR はリポジトリをまたぐので、少なくとも2本に分ける。

1. **bsky-affirmative-bot**：lexicon・DB・AppView（機能フラグ `NAGI_PRIVATE_SPACE_ENABLED` 既定 off）
2. **nagi_client**：オプトインと移行画面（AppView の PR が本番に出てから）

---

## 7. スケジュール

作業は「プロトコルに依らない部分」と「PDS と実際に話す部分」に分ける。前者は β 前に作れるが、
後者（credential の署名ヘッダ、LtHash の照合、通知の受け口、delegation token の受け渡し）は
実機のレスポンスを見ないと正しく書けないので、β 後に作る。後者は「ちょっと直す」ではなく
AppView 側の作業の半分以上を占める。

| 時期 | 内容 | マージ |
|---|---|---|
| 11/28〜11/30 | プロトコルに依らない部分：lexicon、DB マイグレーション、保存先の判定と書き込み API のガード、エクスポート API、レコード ⇄ テーブルの対応付けと検証（単体テスト付き）。ブランチに積むだけで PR は出さない | — |
| 12/1〜12/3 | β の実機確認（5章）。開発機に Spaces 対応 PDS を立て、curl で一連の流れを通す。結果で計画を直す | しない |
| 12/3〜12/8 | PDS と話す部分：space XRPC クライアント、credential 管理、LtHash、取り込みワーカー、通知の受け口。開発機の PDS と結合テストする | — |
| 12/8〜12/12 | クライアントのオプトインと移行画面。開発環境で移行と戻しを通す。**全部そろったら AppView とクライアントの PR を出す** | オーナー判断でマージ（AppView はフラグ off のまま） |
| 12/13〜 | 本番でフラグを on。最初はオーナーのアカウントだけ、次に希望者へ案内 | — |
| 全員が移れるまで | AppView 保存の経路は残す。Bluesky の PDS が未対応なら、ここが延びる | — |

2.3 の既読状態と、AppView 保存経路の撤去は、上のすべてが落ち着いてから別に決める。

---

## 8. 進み具合

### 11/28 にブランチへ積んだもの（β 前に作れる部分、フラグ off、PR は未提出）

- lexicon：space type 宣言 `com.suibari.nagi.private`、レコード13本、XRPC 4本
  （`getPrivateSpaceStatus` / `beginPrivateSpaceMigration` / `abortPrivateSpaceMigration` / `exportPrivateData`）。
  XRPC は permission-set の rpc に追加した。**再公開（`pnpm lex:publish`）はマージ時にオーナーが行う。**
  β 後にすべて実装してから PR を出す（途中の PR は出さない）。
- DB：`nagi.private_spaces`（保存先。行が無ければ appview）。
- AppView：
  - `privateSpace/guard.ts`：従来の書き込み API の門番。ミュート・非公開リスト・ブックマーク・下書き・
    設定のうち移る項目は、移行中 423、移行後 409。ブックマークの既定フォルダの自動作成も、移行後は止める。
  - `privateSpace/records.ts`：テーブル ⇄ レコードの変換と、取り込み時の検証（従来の API と同じ検証関数を使う）。
  - `privateSpace/storage.ts`：移行の開始・中断・状態・書き出し。開始は書き込みと同じ advisory lock を取る。
  - `NAGI_PRIVATE_SPACE_ENABLED`（既定 off）。off でも門番は効く。
- テスト：変換の往復、検証、門番、lexicon のそろい（`privateSpace.test.ts`）、Postgres を通した状態遷移
  （`privateSpace.postgres.test.ts`、`NAGI_PRIVATE_SPACE_TEST_DATABASE_URL`）。

### β 後に足すもの

- space XRPC クライアント（credential の署名ヘッダ）、credential 管理、LtHash、取り込みワーカー、
  通知の受け口、`syncPrivateSpace`、移行完了（照合して `space` へ切り替える）。
- `nagi.private_spaces` に同期状態（rev・LtHash・credential の期限・通知の登録）を足す。

---

## 9. リスク

- **仕様がまだ動く。** ガイドは 11/26 に改訂されたばかりで、記述の食い違い（3.6）もある。
  lexicon と XRPC の型は `permissioned-data` ブランチから取り込み、β の変更に追従しやすくしておく。
- **暗号化はされない。** 本人の PDS の運営者は中身を読める。今は Nagi の運営者が読める状態なので
  「誰が読めるか」が入れ替わる。プライバシーポリシーの記述を移行の公開前に直す。
- **公開レコードとの取り違え。** space の書き込みは `com.atproto.space.*`、公開レコードは
  `com.atproto.repo.*`。ミュートや非公開リストを誤って `repo.createRecord` で書くと全世界に公開される。
  クライアントの space アダプタは私的コレクションを `repo.*` に渡せない型にし、テストで固める。
- **AppView のコピーの鮮度。** credential が切れているあいだに他アプリが書いた分は、本人が次に
  Nagi を開くまで反映されない。Nagi 以外が書く想定は今のところ無い。
- **規模の割に恩恵が届く人が少ない。** 初期に移れるのは自前 PDS のユーザ（16/69）だけの可能性がある。
  そのため AppView 側を先に作り、フラグ off でマージしておき、対応 PDS が増えた時点で順次案内する。
