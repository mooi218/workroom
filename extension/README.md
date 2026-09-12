# Workroom browser observer

Chrome / Edge 用の Manifest V3 拡張です。開いている ChatGPT Work の表示状態を、同じパソコンで動く Workroom に反映します。

## 使い方

1. Workroom を起動し、設定にある接続コードをコピーします。
2. Chrome の `chrome://extensions` または Edge の `edge://extensions` を開き、開発者モードをオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」で、この `extension` フォルダーを選びます。
4. 拡張機能のポップアップに接続コードを貼り付け、保存します。
5. ChatGPT の会話を開きます。Work の明示表示を認識できれば自動で追跡します。「このタスクを追跡」を選ぶと、その会話を明示的に追跡できます。
6. 停止するときは「このタスクの追跡を停止」を選びます。その会話の自動追跡も停止します。もう一度追跡を選ぶと再開します。

選択は会話 ID ごとに保存されます。別の会話への移動で手動選択が引き継がれることはありません。「Work 表示のあるタスクを自動追跡」は設定でオフにできます。

## 観測できる範囲

**実際の ChatGPT Work 画面で DOM セレクターの動作を検証していません。** 同梱テストは合成した UI 情報とブラウザー API の代替実装を使うテストです。実アカウントでの接続、セレクター一致、Chrome / Edge の拡張インストールを確認したという意味ではありません。画面構造や言語が変わると認識できなくなるため、まず手動で追跡し、実際の表示と照合してください。

この拡張は非公式の表示観測ツールです。OpenAI の公式ガイドは Work の進捗表示を説明していますが、拡張向けの DOM セレクター契約は示していません。[Get started with ChatGPT Work](https://learn.chatgpt.com/docs/get-started-with-work)

- 対象 URL は `https://chatgpt.com/c/<conversation-id>` と `https://chatgpt.com/g/<gpt-id>/c/<conversation-id>` です。他の画面や URL 形式は対象外です。
- 自動追跡は現在の会話の Work モード表示が明示的に選択されている場合、または Work 専用の表示属性がある場合だけです。サイドバーの「Work」、メニューの未選択項目、会話本文に書かれた「Work」は根拠にしません。
- 作業中は表示された停止ボタン、対象タスクの `aria-busy`、または明示的な状態表示を根拠にします。
- 確認待ち・完了・エラー・待機中は、対象タスクの短い状態ラベルを根拠にします。完了は `Completed` や「作業完了」などの明示表示がある場合だけです。
- 停止ボタンが消えたこと、最後にメッセージが届いたこと、時間が経過したことから完了とは推定しません。根拠の不在や矛盾は「不明」です。
- 会話タブが閉じられる、ブラウザーが停止する、タブが休止する、接続が途切れると最新状態を観測できません。Workroom は観測の鮮度を別途判定します。閉じたタスクを追跡する非公開 API 呼び出しは行いません。
- 複数の会話タブを同時に追跡できます。認識するラベルは主に日本語と英語です。

## データとコスト

拡張機能はモデル呼び出しを行わず、プロンプトを送らず、新しい AI タスクも作りません。この観測処理に AI クレジットは不要です。元の ChatGPT / Codex 作業の利用量は通常どおりです。

読むのはページのタイトル、会話 URL、対象タスクの UI に表示された状態の根拠です。会話本文、添付ファイル、Cookie、ChatGPT の認証トークン、ページの localStorage / sessionStorage は読みません。本文に含まれる状態語は除外します。URL の検索パラメーターとフラグメントも送信しません。

送信先はコードに固定された `http://127.0.0.1:4318/api/cloud` のみです。ChatGPT や外部の解析サービスへの通信は行いません。`fetch` は Cookie を送らず、リダイレクトに追従しません。ホスト権限も `http://127.0.0.1:4318/*` に限定します。ポートを指定する形式は [Chrome の match patterns 仕様](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) に基づきます。

接続コードは拡張機能自身の `chrome.storage.local` に保存し、content script から読み取れない設定にします。ChatGPT の認証情報を使用するものではありません。タイトルと会話 URL には個人的な内容が含まれる場合があるため、公開用スクリーンショットを撮る際は Workroom の表示内容をご確認ください。

## 実装

- `observer-core.js`: URL 検証、短い UI ラベルの分類、Work 判定、送信データの許可リスト。ブラウザー DOM に依存しない純粋関数。
- `content.js`: isolated world 内で `MutationObserver` により変更をまとめて観測。500 ms の debounce（連続更新中も最大 2 秒で反映）、30 秒の heartbeat。状態が同じなら変更通知を省略します。会話本文・サイドバー・非表示要素は根拠から除外します。
- `background.js`: service worker が送信元と URL を検証し、接続コードを付けてローカルへ送信。同じタブの送信は直列化します。
- `popup.html`, `popup.css`, `popup.js`: 接続設定と現在のタスクの追跡操作。
- `../tests/cloud-observer.test.mjs`: Node 標準テスト。`node --test tests/cloud-observer.test.mjs` を Workroom のルートで実行します。

POST body:

```json
{
  "observerId": "42",
  "tasks": [{
    "id": "work:01234567-89ab-cdef-0123-456789abcdef",
    "title": "企画書を仕上げる",
    "project": "ChatGPT Work",
    "status": "working",
    "url": "https://chatgpt.com/c/01234567-89ab-cdef-0123-456789abcdef",
    "updatedAt": "2026-09-13T00:00:00.000Z"
  }]
}
```

`Authorization: Bearer <接続コード>` が必要です。`updatedAt` は状態・タイトルの変更時刻を維持し、heartbeat だけでは更新しません。受信時刻 `observedAt` はサーバーが付けます。追跡停止や別の対象外ページへの移動では、同じ `observerId` で空の `tasks` を送ります。

## Contributing

This is an unofficial, local-only observer, not an OpenAI API integration. Its DOM selectors are **not verified against a live ChatGPT Work account**. Please include a minimal, sanitized markup fixture and the UI language when reporting selector issues. Never submit conversation contents, cookies, pairing codes, or authentication data. Preserve the conservative behavior: ordinary chats are excluded unless explicitly selected; missing controls do not imply completion. All model calls, remote telemetry, and credential scraping are outside this extension's scope.
