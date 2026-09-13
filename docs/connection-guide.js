const LOCAL_URL = "http://127.0.0.1:4318";
const FALLBACK_NOTICE = {
  zh: "此连接指南目前提供日语和英语；以下显示英语。",
  es: "Esta guía está disponible en inglés y japonés. Se muestra en inglés.",
  pt: "Este guia está disponível em inglês e japonês. O conteúdo abaixo está em inglês.",
  fr: "Ce guide est disponible en anglais et en japonais. Le contenu ci-dessous est en anglais.",
  hi: "यह कनेक्शन गाइड अभी अंग्रेज़ी और जापानी में उपलब्ध है। नीचे अंग्रेज़ी दिखाई गई है।",
  ar: "يتوفر دليل الاتصال حاليًا بالإنجليزية واليابانية. يُعرض أدناه باللغة الإنجليزية.",
};

const COPY = {
  en: {
    title: "Connect your work",
    close: "Close connection guide",
    languageLabel: "Guide language",
    localTab: "Codex on this PC",
    workTab: "ChatGPT Work in browser",
    intro:
      "The public demo shows fictional jobs. To see your own work, run the downloaded Workroom app on the same computer as Codex and open the local office.",
    demo: "Demo office · sample tasks only",
    local: "Local office · check the connection below",
    connected: "Local connected",
    unavailable: "Local connection not confirmed",
    counts: "Codex: {local} tasks · Work: {work} observed tasks",
    workFresh: "Browser observations are arriving.",
    workStale: "Browser observations are out of date.",
    workNone: "No browser observations received yet.",
    portMismatch:
      "This office is using a different port. The included browser extension connects only to port 4318; restart the local office on 4318 to use it.",
    cliProblem: "Task cards work, but usage or instructions are unavailable",
    cliFix:
      "These features also need the installed Codex CLI app-server and its current signed-in account. Check that Codex CLI is available and uses the intended account and Codex folder. On Windows, complete the sandbox setup in Codex and inspect any reported setup error. Do not bypass operating-system or workspace permission controls. Viewing task cards alone does not confirm that this separate connection is ready.",
    localLead:
      "Automatic local reading. No browser extension, pairing code or API key is needed for this source.",
    workLead:
      "Optional, experimental page observer. It does not synchronize every cloud task, and its installation and selectors have not been verified here against a live ChatGPT Work account.",
    labels: {
      settingsTitle: "Office settings",
      pairShow: "Show pairing code",
      pairCopy: "Copy",
      showAll: "Show all",
      observedAt: "Last observed",
    },
    localSteps: [
      {
        title: "Start the downloaded local app",
        body: "Install Node.js 24 or later, download Workroom and extract the ZIP. Open start-windows.cmd on Windows or start-macos.command on macOS. Alternatively, run the command below in the extracted folder containing package.json. Keep that terminal open.",
        code: "npm start",
        problem: "The launcher does not open or Node is missing",
        fix: "Install Node.js 24 or later, reopen the terminal, and check node --version. Run npm start from the extracted Workroom folder so any startup error stays visible. No npm install step is needed.",
      },
      {
        title: "Open your local office",
        body: "Use Codex on this same computer, then open the address below. Choose real tasks rather than the demo. Compatible local Codex records refresh about every 2.5 seconds; no task is started just to connect.",
        code: LOCAL_URL,
        problem: "The page will not load, or only sample jobs appear",
        fix: "Keep the Workroom terminal running and use the local address, not the public GitHub Pages demo. If you started demo mode, stop that process with Ctrl+C and restart with npm start.",
      },
      {
        title: "Check the Codex count and task list",
        body: "A connected source can have no active work. Use {showAll} and clear project, department and status filters to check older tasks. The task details show {observedAt}.",
        problem: "Codex is unavailable or the expected task is missing",
        fix: "Confirm that Codex has saved tasks on this computer. Workroom reads CODEX_HOME, or the home folder’s .codex directory by default. If you use a different Codex folder, start with --codex-home and that folder. Unsupported record formats remain unconfirmed; no records are repaired.",
      },
    ],
    workSteps: [
      {
        title: "Keep the local office running on port 4318",
        body: "Complete the local startup steps first and keep the office open at this address. The extension connects to port 4318 automatically; its popup only needs the pairing code.",
        code: LOCAL_URL,
        problem: "You are using the public demo or a different port",
        fix: "Start the downloaded local app with npm start and open http://127.0.0.1:4318. A hosted demo cannot receive this extension’s observations.",
      },
      {
        title: "Load the extension in desktop Chrome or Edge",
        body: "Enter the relevant address below in the browser’s address bar. Turn on Developer mode, choose Load unpacked, and select Workroom’s extension folder—the folder containing manifest.json. Open Workroom — ChatGPT Work Observer from the browser’s extensions menu.",
        code: "chrome://extensions\nedge://extensions",
        problem: "Load unpacked is missing or loading fails",
        fix: "Enable Developer mode and select the extracted extension folder, not the ZIP or Workroom’s outer folder. If your organization disables developer extensions, ask its administrator; this guide does not bypass that policy.",
      },
      {
        title: "Copy only the Workroom pairing code",
        body: "In Workroom, open {settingsTitle} → {pairShow} → {pairCopy}. In the extension popup, paste it into Workroom の接続コード and press 保存 (Save). The popup currently uses Japanese labels. You do not paste an endpoint, ChatGPT login token or API key.",
        problem: "The popup reports a mismatched code or an offline office",
        fix: "Copy the code again from this running local office and press 保存. Keep its terminal open on port 4318. The message 接続コードを保存済み means the code is saved, not that a task has already been observed.",
      },
      {
        title: "Choose the correct open Work task",
        body: "Open the task in that same Chrome or Edge browser. Supported conversation paths are /c/<id> and /g/<gpt-id>/c/<id> on chatgpt.com. Refresh the page after installing the extension. Check the popup’s task title, then choose このタスクを追跡 (Track this task). The optional Work 表示のあるタスクを自動追跡 switch only applies when an explicit Work indicator is recognized.",
        problem: "Track this task is disabled or the wrong page is shown",
        fix: "Select the actual conversation tab, not the ChatGPT home page or sidebar. Save the pairing code, refresh the conversation and reopen the extension. Manual selection is tied to that conversation; it does not carry over to another task.",
      },
      {
        title: "Confirm the Work count and freshness",
        body: "Look for このタスクの表示状態を反映しています in the popup, then check Workroom’s Work count. Open the task details and check {observedAt}. If a task is hidden, use {showAll} and clear filters. Leave the browser, task tab and local server running; a heartbeat is sent about every 30 seconds.",
        problem: "Work remains at zero, or its state is unknown",
        fix: "Confirm the popup’s task title and tracking state, the saved code and port 4318. Reload the task page after loading or updating the extension. Unknown can mean an unsupported status display or no fresh observation for about 90 seconds. It does not mean the job finished.",
      },
    ],
    limits:
      "Only supported open/selected pages are observed. Closed, sleeping or otherwise unseen cloud tasks are not automatically synchronized. Missing controls never prove completion. First compare the observed state with the actual task page.",
    stop: "To stop one task, choose このタスクの追跡を停止 in the popup. This also stops automatic tracking for that conversation. 接続を解除 disconnects the extension from this office.",
    privacy:
      "Keep the pairing code private and enter it only in the extension. Do not post it in a chat, issue or screenshot. Observation and display make no model calls; the original Codex/Work tasks still use their normal allowance.",
    download: "Download Workroom",
    node: "Get Node.js",
    openLocal: "Open local office",
    references: "Browser installation instructions",
    chrome: "Chrome guide",
    edge: "Edge guide",
  },
  ja: {
    title: "仕事を接続する",
    close: "接続ガイドを閉じる",
    languageLabel: "ガイドの言語",
    localTab: "このPCのCodex",
    workTab: "ブラウザーのChatGPT Work",
    intro:
      "公開デモに並ぶのは架空の仕事です。自分の仕事を表示するには、Codexと同じパソコンでダウンロードしたWorkroomを起動し、ローカルのオフィスを開きます。",
    demo: "デモのオフィス · サンプルの仕事のみ",
    local: "ローカルのオフィス · 下の接続状態を確認",
    connected: "ローカル接続済み",
    unavailable: "ローカル接続は未確認",
    counts: "Codex：{local}件 · Work：観測した仕事 {work}件",
    workFresh: "ブラウザーからの観測を受信しています。",
    workStale: "ブラウザーの観測が古くなっています。",
    workNone: "ブラウザーからの観測はまだありません。",
    portMismatch:
      "このオフィスは別のポートで動いています。同梱のブラウザー拡張は4318番ポート専用です。拡張を使う場合は、ローカルのオフィスを4318番で起動し直してください。",
    cliProblem: "仕事は見えるが、使用量や指示の機能が使えない",
    cliFix:
      "これらの機能には、インストール済みのCodex CLIのapp-serverと、そこでサインインしているアカウントも必要です。Codex CLIが利用でき、意図したアカウント・Codex保存先を使っているか確認します。WindowsではCodex側のサンドボックス設定を済ませ、設定エラーがあればCodexで確認してください。OSやワークスペースの権限制限は回避しません。仕事のカードが見えることだけでは、この別の接続の準備完了を確認できません。",
    localLead:
      "このパソコンの記録を自動で読み取ります。ブラウザー拡張・接続コード・APIキーは不要です。",
    workLead:
      "任意で使う実験的な画面観測です。クラウドの全仕事を同期する機能ではなく、実際のChatGPT Workアカウントで拡張の導入や画面認識を検証したものではありません。",
    labels: {
      settingsTitle: "オフィスの設定",
      pairShow: "接続コードを表示",
      pairCopy: "コピー",
      showAll: "すべて表示",
      observedAt: "最終観測",
    },
    localSteps: [
      {
        title: "ダウンロードしたアプリを起動する",
        body: "Node.js 24以降を用意し、WorkroomのZIPをダウンロードして展開します。Windowsはstart-windows.cmd、macOSはstart-macos.commandを開きます。起動できない場合は、package.jsonのある展開先フォルダーで下のコマンドを実行します。使っている間はターミナルを開いたままにします。",
        code: "npm start",
        problem: "起動しない・Nodeが見つからない",
        fix: "Node.js 24以降をインストールし、ターミナルを開き直してnode --versionを確認します。Workroomの展開先でnpm startを実行すると、起動エラーを確認できます。npm installは不要です。",
      },
      {
        title: "ローカルのオフィスを開く",
        body: "同じパソコンでCodexを使い、下のアドレスを開きます。デモではなく実際の仕事の表示に切り替えてください。対応するCodexの保存記録を約2.5秒ごとに読み取ります。接続のために新しい仕事を実行する必要はありません。",
        code: LOCAL_URL,
        problem: "ページが開かない・サンプルしか出ない",
        fix: "Workroomのターミナルを起動したままにし、公開デモではなくローカルのアドレスを開きます。デモ専用モードで起動した場合は、そのターミナルでCtrl+Cを押して停止し、npm startで起動し直します。",
      },
      {
        title: "Codexの件数と仕事一覧を確認する",
        body: "接続できていても、進行中の仕事がない場合があります。{showAll}を選び、プロジェクト・部署・状態の絞り込みを解除して過去の仕事も確認します。仕事の詳細にある{observedAt}も確認してください。",
        problem: "Codexが未接続・目的の仕事が見つからない",
        fix: "このパソコンのCodexに仕事が保存されていることを確認します。既定ではCODEX_HOME、未指定ならホーム内の.codexを読みます。保存先を変更している場合は、起動時に--codex-homeでそのフォルダーを指定します。非対応の保存形式は未確認のまま扱い、記録を修復しません。",
      },
    ],
    workSteps: [
      {
        title: "ローカルのオフィスを4318番ポートで起動しておく",
        body: "先に「このPCのCodex」の起動手順を済ませ、下のアドレスでオフィスを開いておきます。拡張は4318番ポートへ接続するので、拡張の画面では接続コードだけを入力します。",
        code: LOCAL_URL,
        problem: "公開デモ・別のポートを使っている",
        fix: "ダウンロードしたアプリをnpm startで起動し、http://127.0.0.1:4318を開きます。公開デモでは、この拡張からの観測を受信できません。",
      },
      {
        title: "ChromeかEdgeに拡張機能を読み込む",
        body: "パソコン版ブラウザーのアドレス欄に、下の該当アドレスを入力します。開発者モードをオンにし、「パッケージ化されていない拡張機能を読み込む」からWorkroomのextensionフォルダーを選びます。manifest.jsonが入っているフォルダーです。ブラウザーの拡張機能メニューからWorkroom — ChatGPT Work Observerを開きます。",
        code: "chrome://extensions\nedge://extensions",
        problem: "読み込みボタンがない・読み込みに失敗する",
        fix: "開発者モードをオンにし、ZIPや外側のWorkroomフォルダーではなく、展開済みのextensionフォルダーを選びます。組織の管理設定で禁止されている場合は管理者に確認してください。制限を回避する手順は案内しません。",
      },
      {
        title: "Workroomの接続コードだけをコピーする",
        body: "Workroomの{settingsTitle} → {pairShow} → {pairCopy}を選びます。拡張の「Workroom の接続コード」欄へ貼り付け、「保存」を押します。接続先アドレス、ChatGPTのログイントークン、APIキーを入力する操作ではありません。",
        problem: "コード不一致・オフィスに接続できないと表示される",
        fix: "いま起動しているローカルのWorkroomからコードをコピーし直し、「保存」を押します。4318番ポートのターミナルを開いたままにしてください。「接続コードを保存済み」は保存できたという意味で、仕事を受信した確認ではありません。",
      },
      {
        title: "正しいWorkの仕事を開いて追跡する",
        body: "同じChromeまたはEdgeでWorkの仕事を開きます。対象はchatgpt.comの/c/<id>または/g/<gpt-id>/c/<id>形式の会話ページです。拡張の導入後はページを再読み込みします。拡張に表示された仕事名を確認し、「このタスクを追跡」を押します。「Work 表示のあるタスクを自動追跡」は、明示的なWork表示を認識した場合だけ働きます。",
        problem: "追跡ボタンが押せない・別の画面が出る",
        fix: "ChatGPTのホームやサイドバーではなく、対象の会話タブを選択します。接続コードを保存し、会話を再読み込みして拡張を開き直します。手動の選択はその会話だけに保存され、別の仕事へは引き継がれません。",
      },
      {
        title: "Workの件数と最終観測を確認する",
        body: "拡張に「このタスクの表示状態を反映しています」と出ることを確認し、WorkroomのWork件数を見ます。仕事の詳細では{observedAt}を確認します。見つからない場合は{showAll}にして絞り込みを解除してください。ブラウザー・仕事のタブ・ローカルサーバーを起動したままにすると、約30秒ごとにも観測を送ります。",
        problem: "Workが0件のまま・状態が未確認になる",
        fix: "拡張の仕事名・追跡状態・保存したコード・4318番ポートを確認します。拡張の導入や更新後は仕事のページも再読み込みしてください。非対応の状態表示や約90秒以上の観測途切れは未確認になります。完了したという意味ではありません。",
      },
    ],
    limits:
      "観測するのは、対応する開いたページ・選択した仕事だけです。閉じたタブ、休止したタブ、画面に出ていないクラウドの仕事を自動で全件同期しません。ボタンが消えただけで完了とは判断しないため、最初は実際の仕事の画面と状態を照合してください。",
    stop: "1件の追跡を止めるには、拡張で「このタスクの追跡を停止」を選びます。その会話の自動追跡も停止します。「接続を解除」は拡張とオフィスの接続を解除します。",
    privacy:
      "接続コードは拡張機能の入力欄だけに使い、チャット・公開Issue・スクリーンショットへ載せないでください。観測や表示ではモデルを呼びません。元のCodex・Workの仕事自体には通常の利用量が発生します。",
    download: "Workroomをダウンロード",
    node: "Node.jsを入手",
    openLocal: "ローカルのオフィスを開く",
    references: "ブラウザーの公式導入手順",
    chrome: "Chromeの手順",
    edge: "Edgeの手順",
  },
};

export function getConnectionGuideContent(locale = "en") {
  const requested = String(locale || "en")
    .toLowerCase()
    .split(/[-_]/)[0];
  const language = requested === "ja" ? "ja" : "en";
  return {
    language,
    requested,
    fallback: FALLBACK_NOTICE[requested] || "",
    ...COPY[language],
  };
}

let guideNumber = 0;
export function createConnectionGuide({
  t,
  getLocale = () => "en",
  getContext = () => ({}),
  document: doc = globalThis.document,
} = {}) {
  const id = `connection-guide-${++guideNumber}`;
  const dialog = doc.createElement("dialog");
  dialog.className = "connection-guide";
  dialog.id = id;
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-intro`);
  doc.body.append(dialog);
  let currentTab = "local",
    chosenLanguage = null,
    opener,
    destroyed = false;
  const make = (tag, className, text) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function safeContext() {
    try {
      return getContext() || {};
    } catch {
      return {};
    }
  }
  function render() {
    if (destroyed) return;
    const requested = getConnectionGuideContent(getLocale());
    const copy = getConnectionGuideContent(chosenLanguage || getLocale());
    dialog.lang = copy.language;
    dialog.dir = "ltr";
    const fill = (text) =>
      text.replace(/\{([a-zA-Z]+)\}/g, (whole, key) => {
        const translated =
          typeof t === "function" && key in copy.labels ? t(key) : null;
        return translated && translated !== key
          ? translated
          : copy.labels[key] || whole;
      });
    const header = make("header", "connection-guide-header");
    const heading = make("h2", "", copy.title);
    heading.id = `${id}-title`;
    const close = make("button", "connection-guide-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", copy.close);
    close.onclick = () => dialog.close();
    header.append(heading, close);
    const content = make("div", "connection-guide-content");
    const intro = make("p", "connection-guide-intro", copy.intro);
    intro.id = `${id}-intro`;
    const context = safeContext();
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
      doc.location?.hostname || globalThis.location?.hostname || "",
    );
    const demo =
      context.mode === "demo" ||
      context.demo === true ||
      context.isDemo === true ||
      !loopback;
    const state = make("section", "connection-guide-state");
    state.append(
      make(
        "strong",
        "",
        demo
          ? copy.demo
          : context.local?.status === "connected"
            ? copy.connected
            : context.local?.status === "unavailable"
              ? copy.unavailable
              : copy.local,
      ),
    );
    if (!demo) {
      const count = (value) =>
        value != null && Number.isFinite(Number(value)) && Number(value) >= 0
          ? String(Math.min(1000000, Math.floor(Number(value))))
          : "—";
      state.append(
        make(
          "p",
          "",
          copy.counts
            .replace("{local}", count(context.local?.taskCount))
            .replace("{work}", count(context.cloud?.taskCount)),
        ),
      );
      state.append(
        make(
          "p",
          "",
          context.cloud?.status === "connected"
            ? copy.workFresh
            : context.cloud?.status === "stale"
              ? copy.workStale
              : copy.workNone,
        ),
      );
    }
    const languageRow = make(
      "label",
      "connection-guide-language",
      copy.languageLabel,
    );
    const language = make("select");
    for (const [value, name] of [
      ["en", "English"],
      ["ja", "日本語"],
    ]) {
      const option = make("option", "", name);
      option.value = value;
      language.append(option);
    }
    language.value = copy.language;
    language.onchange = () => {
      chosenLanguage = language.value;
      render();
      dialog.querySelector("select")?.focus();
    };
    languageRow.append(language);
    content.append(intro, state, languageRow);
    const port = String(
      context.port ?? doc.location?.port ?? globalThis.location?.port ?? "",
    );
    if (!demo && port !== "4318")
      content.append(make("p", "connection-guide-limit", copy.portMismatch));
    if (!chosenLanguage && requested.fallback) {
      const notice = make("p", "connection-guide-fallback", requested.fallback);
      notice.lang = requested.requested;
      notice.dir = requested.requested === "ar" ? "rtl" : "ltr";
      content.append(notice);
    }
    const tabs = make("div", "connection-guide-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", copy.title);
    for (const [index, key] of ["local", "work"].entries()) {
      const tab = make(
        "button",
        "connection-guide-tab",
        key === "local" ? copy.localTab : copy.workTab,
      );
      tab.id = `${id}-${key}-tab`;
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", `${id}-${key}-panel`);
      tab.setAttribute("aria-selected", String(currentTab === key));
      tab.tabIndex = currentTab === key ? 0 : -1;
      const choose = (next) => {
        currentTab = next;
        render();
        dialog.querySelector(`#${id}-${next}-tab`)?.focus();
      };
      tab.onclick = () => choose(key);
      tab.onkeydown = (event) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          choose(
            event.key === "Home"
              ? "local"
              : event.key === "End"
                ? "work"
                : index === 0
                  ? "work"
                  : "local",
          );
        }
      };
      tabs.append(tab);
    }
    content.append(tabs);
    for (const key of ["local", "work"]) {
      const panel = make("section", "connection-guide-panel");
      panel.id = `${id}-${key}-panel`;
      panel.hidden = currentTab !== key;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `${id}-${key}-tab`);
      panel.tabIndex = 0;
      panel.append(
        make(
          "p",
          "connection-guide-lead",
          key === "local" ? copy.localLead : copy.workLead,
        ),
      );
      const steps = make("ol", "connection-guide-steps");
      for (const step of key === "local" ? copy.localSteps : copy.workSteps) {
        const item = make("li"),
          title = make("h3", "", step.title),
          body = make("p", "", fill(step.body));
        item.append(title, body);
        if (step.code) {
          const code = make("pre", "connection-guide-code", step.code);
          code.dir = "ltr";
          item.append(code);
        }
        const help = make("details", "connection-guide-help");
        help.append(
          make("summary", "", step.problem),
          make("p", "", fill(step.fix)),
        );
        item.append(help);
        steps.append(item);
      }
      panel.append(steps);
      if (key === "local") {
        const help = make("details", "connection-guide-help");
        help.append(
          make("summary", "", copy.cliProblem),
          make("p", "", copy.cliFix),
        );
        panel.append(help);
      }
      if (key === "work")
        panel.append(
          make("p", "connection-guide-limit", copy.limits),
          make("p", "connection-guide-stop", copy.stop),
        );
      content.append(panel);
    }
    const resources = make("nav", "connection-guide-links");
    resources.setAttribute("aria-label", copy.download);
    for (const [text, url] of [
      [copy.download, "https://github.com/mooi218/workroom/releases/latest"],
      [copy.node, "https://nodejs.org/"],
      [copy.openLocal, LOCAL_URL],
    ]) {
      const anchor = make("a", "", text);
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      resources.append(anchor);
    }
    content.append(
      resources,
      make("p", "connection-guide-privacy", copy.privacy),
    );
    const references = make("details", "connection-guide-references");
    references.append(make("summary", "", copy.references));
    for (const [text, url] of [
      [
        copy.chrome,
        "https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world",
      ],
      [
        copy.edge,
        "https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading",
      ],
    ]) {
      const anchor = make("a", "", text);
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      references.append(anchor);
    }
    content.append(references);
    dialog.replaceChildren(header, content);
  }
  const onClose = () => {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  dialog.addEventListener("close", onClose);
  render();
  return {
    open(tab = "local") {
      if (destroyed) return;
      currentTab = tab === "work" ? "work" : "local";
      chosenLanguage = null;
      if (!dialog.open) opener = doc.activeElement;
      render();
      if (!dialog.open) dialog.showModal();
      dialog.querySelector(`#${id}-${currentTab}-tab`)?.focus();
    },
    close() {
      if (dialog.open) dialog.close();
    },
    refreshText: render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (dialog.open) dialog.close();
      dialog.removeEventListener("close", onClose);
      dialog.remove();
    },
  };
}
