import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoSnapshot } from "../lib/demo.mjs";
import { DEFAULT_ROLES } from "../lib/roles.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Explicit asset allowlist: never copy runtime data, browser state, screenshots,
// Codex records or an arbitrary directory into the public demo.
export const DEMO_ASSETS = [
  "app.js",
  "office.js",
  "sound.js",
  "sound-catalog.js",
  "features-i18n.js",
  "controls.js",
  "connection-guide.js",
  "connection-guide.css",
  "work-selection.js",
  "work-selection.css",
  "i18n.js",
  "projects.js",
  "delivery.js",
  "focus.js",
  "style.css",
  "studio.css",
  "delivery.css",
  "pixel-ui.css",
  "favicon.svg",
  "assets/people-coarse.png",
  "assets/people-actions-coarse.png",
  "assets/furniture-coarse-1.png",
  "assets/furniture-coarse-2.png",
  "assets/furniture-coarse-3.png",
  "assets/furniture-coarse-4.png",
  "assets/skyline.svg",
  "assets/frame-light.svg",
  "assets/frame-dark.svg",
  "assets/fonts/pixelify-sans.woff2",
  "assets/fonts/ibm-plex-sans.woff2",
  "assets/fonts/noto-sans-jp.woff2",
  "assets/fonts/pixelify-sans-OFL.txt",
  "assets/fonts/ibm-plex-sans-OFL.txt",
  "assets/fonts/noto-sans-jp-OFL.txt",
];
const titles = [
  "Build the customer portal",
  "Fix the sign-in screen",
  "Review the release tests",
  "Create the campaign visuals",
  "Explore a new logo",
  "Prepare the launch announcement",
  "Review the social posts",
  "Put together the customer proposal",
  "Prepare a project estimate",
  "Write next week’s article",
  "Proofread the newsletter",
  "Research the market",
  "Review customer interviews",
  "Plan the next quarter",
  "Organize the team schedule",
];
export async function buildDemo(output = path.join(root, "docs")) {
  await mkdir(output, { recursive: true });
  let html = await readFile(path.join(root, "public", "index.html"), "utf8");
  if (!html.includes('<html lang="ja">'))
    throw new Error("Expected local app document marker");
  html = html
    .replace('<html lang="ja">', '<html lang="en" data-mode="demo">')
    .replaceAll('href="/', 'href="./')
    .replaceAll('src="/', 'src="./')
    .replace(
      /<title>[\s\S]*?<\/title>/,
      "<title>Workroom</title>",
    );
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
    '<meta name="description" content="Turn Codex work into a living pixel studio. Explore roles, speech bubbles, a completion tray and optional office life in this interactive demo.">',
  );
  html = html.replace(
    "</head>",
    '<link rel="canonical" href="https://mooi218.github.io/workroom/"><meta property="og:title" content="Workroom — A living pixel studio"><meta property="og:type" content="website"><meta property="og:description" content="See your work in motion. Try the interactive office demo, then connect your own Codex tasks locally."></head>',
  );
  // The online demo shares the app UI, but has no local-server connection.
  await writeFile(path.join(output, "index.html"), html);
  // The public demo never redistributes the user's imported recordings.
  await writeFile(
    path.join(output, "sound-manifest.json"),
    JSON.stringify({ available: [] }),
  );
  for (const asset of DEMO_ASSETS) {
    const target = path.join(output, asset);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, "public", asset), target);
  }
  await copyFile(
    path.join(root, "lib", "roles.mjs"),
    path.join(output, "roles.mjs"),
  );
  await copyFile(
    path.join(root, "lib", "selection-model.mjs"),
    path.join(output, "selection-model.mjs"),
  );
  const snapshot = demoSnapshot(),
    time = "2026-01-01T12:00:00.000Z";
  snapshot.tasks = snapshot.tasks.map((task, i) => ({
    ...task,
    title: titles[i],
    projectKey: `demo:${task.project}`,
    projectKind: "project",
    projectName: task.project,
    observedAt: time,
    updatedAt: time,
    summary: "Fictional demonstration task.",
  }));
  await writeFile(
    path.join(output, "demo-data.json"),
    JSON.stringify(
      {
        ...snapshot,
        roles: DEFAULT_ROLES,
        demo: true,
        updatedAt: time,
        cloud: { status: "demo" },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(output, ".nojekyll"), "");
  return {
    output,
    files: DEMO_ASSETS.length + 6,
    tasks: snapshot.tasks.length,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(await buildDemo());
