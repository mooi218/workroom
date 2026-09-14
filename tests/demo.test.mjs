import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildDemo, DEMO_ASSETS } from "../scripts/build-demo.mjs";
import { detectLocale } from "../public/i18n.js";
test("static demo publishes only explicit app assets and fictional jobs", async () => {
  const parent = path.resolve(process.env.WORKROOM_TEST_TMP || os.tmpdir());
  const output = await mkdtemp(path.join(parent, "workroom-demo-"));
  try {
    await buildDemo(output);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(html, /<html lang="en" data-mode="demo">/);
    assert.doesNotMatch(html, /(?:src|href)="\/(?!\/)/);
    const data = JSON.parse(
      await readFile(path.join(output, "demo-data.json"), "utf8"),
    );
    assert.equal(data.demo, true);
    assert.equal(data.tasks.length, 15);
    assert.ok(
      data.tasks.every(
        (task) =>
          task.id.startsWith("demo-") && task.projectKey.startsWith("demo:"),
      ),
    );
    assert.ok(
      DEMO_ASSETS.every(
        (asset) =>
          !asset.includes("workroom.png") && !asset.includes("runtime"),
      ),
    );
    await assert.rejects(stat(path.join(output, "workroom.png")));
    await stat(path.join(output, "assets/fonts/noto-sans-jp-OFL.txt"));
    await stat(path.join(output, "selection-model.mjs"));
    await stat(path.join(output, "work-selection.js"));
    await assert.rejects(stat(path.join(output, "display-selection.json")));
  } finally {
    assert.equal(path.dirname(path.resolve(output)), parent);
    await rm(output, { recursive: true, force: true });
  }
});
test("new visitors start with a supported browser language and a stable English fallback", () => {
  assert.equal(detectLocale(["ja-JP", "en-US"]), "ja");
  assert.equal(detectLocale(["de-DE", "fr-FR"]), "fr");
  assert.equal(detectLocale(["zz"]), "en");
});
