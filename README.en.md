# Workroom

A little pixel office for your Codex and observed ChatGPT Work tasks. Departments and desks grow with the work. No four-seat limit, model calls, API keys, or runtime dependencies.

[日本語](README.md) · [Browser extension](extension/README.md) · [MIT](LICENSE)

## Run locally

Install [Node.js 24+](https://nodejs.org/), download this repository, and run:

```sh
npm start
```

Open **http://127.0.0.1:4318**. No `npm install` is needed. Windows users can double-click `start-windows.cmd`. Stop with Ctrl+C. The app does not register itself to start with the OS.

```sh
npm run demo
```

The demo uses fictional tasks. You can also switch to the demo from the live office.

## Features

- Engineering, design, PR, sales, editorial, research, planning, operations, and custom departments.
- Active work only by default, with task titles in speech bubbles. Observed activities in the current turn may place one job in several departments without creating extra AI jobs.
- Deterministic classification by title, subagent assignment and project keywords; per-task overrides saved in your browser.
- One desk per task, additional rooms as needed, responsive layout, project/status/team filters and an accessible task list.
- Read-only local Codex status refresh every 2.5 seconds, including ordinary subagents across local projects.
- Optional typing animation and short start/completion/attention sounds, independent toggles and volume control. Sound is off by default. Reduced-motion preferences are respected.
- Coffee, printing, sofa breaks and sleeping are playful office effects. Leaving the desk is a separate toggle, **off by default**; the task bubble and status stay at the original desk. Turning animation off stops all motion.
- Japanese, English, Simplified Chinese, Spanish, Portuguese, French, Hindi and Arabic UI, including RTL layout. Actual task titles retain their original language; there are no AI translation calls.
- Light, dark and system themes, persisted in the browser.
- No analytics, remote fonts, external image assets, cloud hosting, inference, or paid monitoring jobs.

**Monitoring, classification, rendering and notifications use zero additional AI credits.** Actual Codex/Work execution and any AI-assisted development of this app retain their normal usage. The app still uses local CPU, memory and electricity.

## Coverage and honest states

**Local Codex:** Reads unarchived task metadata from this computer's Codex SQLite files and bounded JSONL tails. It never starts/resumes a turn, changes a task, repairs Codex data or reads authentication files. Internal guardian review tasks are excluded; ordinary subagents are included. “Done” means the latest turn ended, not that an entire project is finished. An in-progress record without activity for 15 minutes becomes “Unknown”, since a long-running tool and a stopped process cannot always be distinguished.

**ChatGPT Work:** The included Chrome/Edge extension observes explicitly selected or clearly identified Work pages. It sends only title, conversation URL and visible state to your local server using a pairing code. It does not read cookies, credentials, hidden messages or conversation bodies. Stale observations become unknown after 90 seconds.

**This release does not provide full background synchronization of every cloud Work task.** No public all-Work status API was established in this implementation. Unopened/unobserved cloud work and tasks on other computers are outside coverage. The actual ChatGPT DOM and extension installation have not been verified in the development environment; selectors may need updates. Missing activity is never treated as successful completion. See [extension instructions](extension/README.md).

Department detection uses deterministic rules over current-turn tool names, changed paths, bounded command metadata and explicit subagent assignments. Departments are accumulated for that turn; seats do not represent independent AI agents or prove exact concurrent execution. Direct calls written in orchestration code are classified statically without resolving variables or branch execution. This is not semantic AI understanding. Unknown or indirect tool usage may not be recognized; title and assignment keywords are the fallback. The detail panel distinguishes observed activity from keyword classification. Office life effects do not indicate actual tool actions.

Codex's on-disk schema is private and can change. Unsupported versions degrade to unavailable/unknown. The [official App Server protocol](https://learn.chatgpt.com/docs/app-server) does not establish that a separately launched server can observe every task owned by an already running desktop instance; this app uses a read-only local adapter.

## Settings and data

```sh
node server.mjs --codex-home /path/to/.codex --port 4318 --data-dir /path/to/workroom-data
```

Codex home defaults to `CODEX_HOME`, then your home directory's `.codex`. The pairing code is stored in `.workroom/` in the launch directory. Preferences, custom roles and assignments are browser-local. Cloud observations stay in server memory and must be observed again after a restart. The extension uses port 4318.

The server binds only to loopback and checks Host/Origin. Do not expose it to a public network. Keep the pairing code private. `.workroom/`, logs, databases, session files and environment files are ignored by Git. Only generic source and synthetic fixtures belong in a public repository. Use demo mode before sharing a screenshot.

## Development

```sh
npm test
npm run check
```

Tests use synthetic SQLite/JSONL, local HTTP/SSE and synthetic DOM observations. They do not submit work to Codex or ChatGPT. Canvas rendering is restricted to the viewport; animation pauses in hidden tabs. All pixel artwork and notification tones are generated by original code.

This is an independent community project, not an official OpenAI product. Contributions should preserve the zero-inference, local-only design. When reporting issues, include OS and Node/Codex versions; never attach private logs, task databases or pairing codes.
