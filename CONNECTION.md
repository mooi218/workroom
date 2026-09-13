# Connect Workroom to your work

[日本語](CONNECTION.ja.md) · [Back to Workroom](README.md)

**The public demo shows fictional jobs. To connect your own work, run the downloaded Workroom app on your computer.**

| What you want to see | Connection |
| --- | --- |
| Codex work saved on this PC | Automatic local reading; no extension or pairing code |
| ChatGPT Work in Chrome or Edge | Optional browser observer; supported open/selected pages only |
| Every cloud task, including closed pages or another computer | Not supported by this observer |

## 1. Start the local office

1. Install [Node.js 24 or later](https://nodejs.org/).
2. [Download Workroom](https://github.com/mooi218/workroom/releases/latest) and extract its ZIP.
3. Open `start-windows.cmd` on Windows or `start-macos.command` on macOS. Alternatively, open a terminal in the extracted folder containing `package.json` and run:

   ```sh
   npm start
   ```

4. Open [http://127.0.0.1:4318](http://127.0.0.1:4318) and keep the terminal running. Choose real tasks rather than demo tasks. No `npm install` is needed.

If the launcher does not work, check `node --version`, reopen the terminal after installing Node, and run `npm start` from the extracted folder so the error remains visible. If the browser says the local page cannot be reached, confirm the server is still running. The public GitHub Pages demo does not connect to your local records.

## 2. Connect Codex on this PC

Use Codex on the same computer. Workroom automatically reads compatible saved tasks, across projects and ordinary subagents, about every 2.5 seconds. No new task, prompt, API key or browser extension is required to establish this connection.

Check the Codex count. **Active only can hide completed or unconfirmed tasks**: choose **Show all** and clear project, department and state filters. Task details show **Last observed**.

If local data is unavailable, confirm that Codex has saved tasks on this PC. Workroom uses `CODEX_HOME`, or your home folder’s `.codex` directory when it is unset. If you chose another folder, start with `--codex-home` and that folder. Unsupported local formats remain unavailable/unconfirmed; Workroom does not repair the records.

**Cards visible, but usage or instructions unavailable:** those features also need the installed Codex CLI app-server and its current signed-in account. Check the CLI, intended account and Codex folder. On Windows, complete the sandbox setup in Codex and review any setup error there. Do not bypass OS or workspace permissions. Reading local cards and connecting these CLI features are separate checks.

## 3. Optionally connect ChatGPT Work in the browser

This is an **experimental, unofficial page observer**. Its installation flow and page selectors have **not been verified here against a live ChatGPT Work account**. It is not an all-cloud synchronization API. First compare its observed state with the real task page.

1. Keep the local office open at **http://127.0.0.1:4318**. The extension connects to this local app automatically; its popup only needs the pairing code.
2. In desktop Chrome, enter `chrome://extensions`; in Edge, enter `edge://extensions`. Enable **Developer mode**, choose **Load unpacked**, and select Workroom’s extracted **`extension` folder containing `manifest.json`**. This is the browser’s local extension-loading workflow. [Chrome instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world), [Edge instructions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading).
3. In Workroom, open **Office settings → Show pairing code → Copy**. Open **Workroom — ChatGPT Work Observer** from the browser’s extensions menu. Paste the code into **Workroom の接続コード** and press **保存** (Save). The popup currently uses Japanese labels. Copy only the pairing code; no ChatGPT login token, API key or endpoint is requested.
4. Open the correct Work conversation in that same browser. Supported paths on `chatgpt.com` are `/c/<id>` and `/g/<gpt-id>/c/<id>`. Reload the page after installing/updating the extension. Confirm the popup’s task title, then press **このタスクを追跡** (Track this task). **Work 表示のあるタスクを自動追跡** only tracks automatically when an explicit Work indicator is recognized.
5. Check for **このタスクの表示状態を反映しています** in the popup, then inspect Workroom’s **Work count** and the task’s **Last observed** time. Use **Show all** and clear filters if the task is hidden. Leave the browser, task tab and server running; the observer also sends a heartbeat about every 30 seconds.

### Find the failed step

| What you see | What to check |
| --- | --- |
| Load unpacked is missing or loading fails | Enable Developer mode; select the extracted `extension` folder, not the ZIP or outer folder. If your organization blocks developer extensions, ask its administrator. |
| Code does not match | Copy it again from the currently running local Workroom and press 保存. Do not use a code from another extracted installation. |
| Office is offline | Keep Workroom running on port 4318. A different port or the public demo cannot receive this extension. |
| Track button is disabled | Select a supported conversation tab, save the code, reload the page and reopen the popup. The home page and sidebar are not the conversation. |
| Code saved, but no Work task | Saved does not mean observed. Confirm the correct title and choose このタスクを追跡. |
| Work stays at zero or becomes unknown | Check the title, tracking state, code, port and page reload. Missing/unsupported status controls, a sleeping tab, or about 90 seconds without fresh observations can produce unknown. Unknown does not mean completed. |

To stop a conversation, choose **このタスクの追跡を停止**. Its automatic tracking also stops until selected again. **接続を解除** disconnects the extension from the office.

Closed, sleeping or unseen cloud tasks cannot supply reliable current state. Selecting one conversation does not select other conversations. Multiple open supported tabs can be observed, but missing controls never prove completion. See the [observer’s coverage and privacy details](extension/README.md).

Keep the pairing code private and enter it only in the extension. Do not post it in chat, issues or screenshots. Observation and display make no model calls. Running or sending instructions to actual Codex/Work tasks still uses the normal allowance.
