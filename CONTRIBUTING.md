# Contributing to Workroom

Help make the office easier to understand and easier to start. Useful contributions include installation fixes, clearer task states, accessibility improvements, translations, and small improvements to office behavior.

## Run the project

Use Node.js 24 or later. There are no runtime packages to install.

```sh
npm run demo -- --open
npm test
npm run check
```

Use the demo and synthetic records for development whenever possible. Test changes against the behavior they affect; visual changes also need a browser check.

## Report a bug

Open a [bug report](https://github.com/mooi218/workroom/issues/new?template=bug_report.yml) with your Workroom version, operating system, Node.js version, and browser. Include Codex’s version if the local adapter is involved. Describe what you expected, what happened, and the smallest way to reproduce it.

Use invented task names and demo screenshots. **Do not attach private conversation logs, Codex databases, authentication data, pairing codes, or screenshots of real task lists.** A short error summary and a synthetic example are more useful than a large log dump.

For the experimental browser observer, also name the page language and describe the control that was visible. A small, invented markup fixture can demonstrate a selector issue. Never copy a real conversation into a fixture. Synthetic selector tests must not be described as verification against a live ChatGPT Work account.

## Suggest a feature

Use the [feature request form](https://github.com/mooi218/workroom/issues/new?template=feature_request.yml). Start with what you are trying to understand or do in the office, then describe the change that would help. A concrete example is welcome; it can be entirely fictional.

## Make a change

- Keep the change focused on one problem. Explain the resulting behavior and any relevant limitation in the pull request.
- Preserve the observation boundary: Workroom reads task state and does not start, stop, or edit a user’s Codex tasks. Keep runtime processing local and rule-based.
- Preserve uncertain states. Missing activity or an absent control is not evidence that a task completed.
- Add or update meaningful tests for state parsing, classification, transport, or settings behavior. Check layout and interaction for visual changes.
- Keep translations in `public/i18n.js` aligned across all supported languages. Preserve interpolation names such as `{tasks}` and `{name}`, and check right-to-left layout when changing shared UI.
- Keep fixtures fictional and independent of your machine’s paths, task titles, or account information.

Before submitting, run `npm test` and `npm run check`. Include the checks that passed and any part you could not verify. You do not need to include raw private output.

## Where things live

| Area | Files |
| --- | --- |
| Local server and updates | `server.mjs` |
| Codex records and cloud observations | `lib/` |
| Office, controls, themes, and translations | `public/` |
| Experimental Chrome / Edge observer | `extension/` |
| Synthetic fixtures and behavioral tests | `tests/` |

Keep `.workroom/`, authentication files, session records, and private screenshots out of commits. The project’s `.gitignore` is a safeguard, not a reason to add real user data to fixtures. Use synthetic demo screenshots or artwork cleared for publication in documentation and distribution packages.

Contributions are covered by the repository’s [MIT License](LICENSE). Workroom is an independent project and is not affiliated with OpenAI.
