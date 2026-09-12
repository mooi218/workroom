# Workroom

**A little office where you can see your work happening.**

Workroom turns activity from your local Codex projects into a live pixel office. Tasks get desks, titles appear in speech bubbles, and departments show the kinds of work being done. Choose a seat to see its task and status, or add a little office life with typing, sounds, coffee breaks, and printing animations.

[Try it in your browser](https://mooi218.github.io/workroom/) · [Download](https://github.com/mooi218/workroom/releases/latest) · [日本語](README.ja.md) · [Contributing](CONTRIBUTING.md) · [MIT License](LICENSE)

The main integration reads **Codex work recorded on this computer**. The included ChatGPT Work browser observer is experimental and only observes supported, open pages; see [coverage](#coverage-and-task-states) before relying on it.

## Start your office

1. Install [Node.js 24 or later](https://nodejs.org/).
2. Download the ZIP from [Releases](https://github.com/mooi218/workroom/releases/latest) and extract it, or clone this repository.
3. Open `start-windows.cmd` on Windows or `start-macos.command` on macOS. The launcher starts Workroom and opens your browser.

You can also run this from the extracted folder on Windows, macOS, or Linux:

```sh
npm start
```

No `npm install` step is needed: Workroom has no runtime package dependencies. Node.js is still required. If a launcher does not open, use the terminal command above.

The office runs at [127.0.0.1:4318](http://127.0.0.1:4318). Keep the launch terminal open while using it, and press **Ctrl+C** there to stop. Workroom does not add itself to your operating system’s startup apps.

### Try sample tasks

Open the [interactive browser demo](https://mooi218.github.io/workroom/) to try the office immediately, including the completion tray. It uses only fictional jobs and does not connect to your Codex records.

Choose **Try the demo** inside Workroom, or start with fictional tasks:

```sh
npm run demo -- --open
```

Use this mode to explore the office, test sounds, or share screenshots. It does not start or change your real Codex tasks.

## Make the work easy to follow

- **See tasks at a glance.** A compact top bar sits above the office map, with task and team details in panels on the right. Active tasks appear by default, with a title bubble and status at each desk. A task list is also available.
- **Focus on the office.** Open just the office map in fullscreen. Press **Escape** to return to the normal view.
- **Collect finished responses.** The delivery tray highlights newly completed responses and links back to their tasks. Older completions are not flagged as new deliveries. Each delivery marks the latest response finishing; the overall project may still be in progress.
- **Organize by role.** Start with engineering, design, public relations, sales, editorial, research, planning, and operations. Add custom roles and keywords, or assign a task manually. Rooms and desks expand with the work; there is no fixed four-seat limit.
- **Follow activity across departments.** One task can appear in several departments when its current turn contains several kinds of recorded activity. Task and seat counts are displayed separately.
- **Find the right project.** Filter by project, department, or state. Task and project groups use readable names to keep the office easy to scan.
- **Choose your atmosphere.** A navy pixel-studio look, readable typography, light mode, graphite dark in gray and black, and green dark give the office its own character. You can also follow your device’s appearance setting.
- **Add a little life.** Sounds, animations, and leaving the desk have separate controls. Sound and leaving the desk start off; volume is adjustable. Reduced-motion preferences are respected.
- **Pick your language.** The first visit follows a supported browser language, with English as the fallback. Switch between English, Japanese, Simplified Chinese, Spanish, Portuguese, French, Hindi, and Arabic; your saved choice takes priority. Task content and custom role names retain their original language.

Coffee, printing, sofa breaks, and sleeping are playful office effects. They do not report actual tool actions. Task bubbles and status indicators remain at their original desks, and turning animations off stops all movement.

## Coverage and task states

| Source | What Workroom can show |
| --- | --- |
| Local Codex app / CLI | Unarchived tasks in compatible local Codex records, across projects and ordinary subagents. Internal guardian review tasks are excluded. |
| ChatGPT Work | Tasks observed on supported, open ChatGPT pages by the optional Chrome / Edge extension. A clearly identified Work page or explicit task selection is required. |
| Other computers or unobserved cloud work | Not covered. Workroom does not synchronize every cloud Work task in the background. |

Local records refresh about every **2.5 seconds**. This is a view of recorded activity: Workroom does not start, resume, stop, or edit the underlying tasks.

**Done means the latest turn completed**, not that an entire project is finished. A local running record with no activity for 15 minutes becomes unconfirmed because a long-running operation and a stopped process cannot always be distinguished. Some kinds of approval or input waits cannot be identified from the saved records.

Department assignment uses fixed rules over current-turn tool names, changed paths, limited command metadata, and explicit subagent assignments. It keeps the departments observed during that turn until the turn ends. Several desks therefore do not imply several independent agents or prove simultaneous execution. Direct calls written in orchestration code can be classified statically; indirect calls and unknown tools may not be recognized. Title and assignment keywords are the fallback, and the detail panel identifies the basis for the assignment.

Codex’s local storage format can change. Unsupported records appear as unavailable or unconfirmed; Workroom does not repair or rewrite Codex data.

### Experimental ChatGPT Work observer

The extension is **not installed automatically**, and its current installation flow and selectors **have not been verified against a live ChatGPT Work account**. It observes the rendered page rather than providing a complete cloud task integration. Page changes can make a status unreadable.

1. Start Workroom normally.
2. Open Chrome or Edge’s extension manager, enable developer mode, and load the `extension` folder as an unpacked extension.
3. In Workroom’s settings, display the pairing code and enter it in the extension’s popup.
4. Open the ChatGPT task page and select it for tracking. Automatic tracking only applies when an explicit Work indicator is recognized.

The observer sends the title, conversation URL, and visible state to the local office. It does not read conversation bodies, cookies, or account credentials. An ordinary chat is not automatically treated as Work. Missing controls never imply successful completion; cloud observations become unconfirmed after about **90 seconds** without an update. Closed, suspended, or otherwise unobserved pages cannot provide a reliable current status.

See the [extension guide](extension/README.md) for its supported URL formats, permissions, and observation rules.

## Local settings and data

The default source is `CODEX_HOME`, or your home directory’s `.codex` folder when that variable is unset. To choose locations or a port:

```sh
node server.mjs --codex-home /path/to/.codex --port 4318 --data-dir /path/to/workroom-data --open
```

- The server listens on `127.0.0.1` only. Keep it on this computer; do not expose it to a network.
- Pairing data is stored in `.workroom/` in the launch folder by default. Keep the pairing code private. The extension uses port **4318**, so retain that port when using it.
- Appearance, language, sound, custom roles, and manual assignments are saved in the browser. Cloud observations stay in server memory and must be observed again after a restart.
- The local adapter extracts task metadata and limited activity details. It does not send conversation bodies, reasoning, tool arguments, or tool output to the browser. It does not read OpenAI authentication files.
- Real task records, pairing data, and private screenshots do not belong in the public repository. Use the demo for screenshots and invented examples for reports.

> **Usage note:** Workroom’s display, classification, synchronization, and effects do not consume AI credits. Running your Codex or Work tasks still uses their normal allowance; the app uses local computer resources.

## Development

Workroom uses Node.js standard libraries and browser APIs: Canvas for the office, Web Audio for tones, and server-sent events for updates. Rendering is limited to the visible area, and animations pause in hidden tabs. The office and its animated sprites are drawn in code, and notification tones are synthesized in code. A separate generated studio artwork provides narrow decorative strips in the header and footer.

Numbers and English text use bundled IBM Plex Sans; Japanese text uses bundled Noto Sans JP. Pixelify Sans is reserved for branding. The font files and their OFL license texts are included with the app.

```sh
npm test
npm run check
```

Tests use synthetic records and local transport fixtures. They do not submit tasks to Codex or ChatGPT, and synthetic observer tests are not live-page validation. See [Contributing](CONTRIBUTING.md) to report a bug, improve a translation, or propose a change.

Workroom is an independent community project, not an official OpenAI product. Released under the [MIT License](LICENSE).
