import { mkdir, copyFile, access } from "node:fs/promises";
import path from "node:path";
import { SOUND_TRACKS } from "../public/sound-catalog.js";

const args = process.argv.slice(2);
const from = args[0];
const destination = path.resolve(args[1] || ".workroom/sounds");
if (!from) {
  console.error(
    'Usage: node scripts/import-sounds.mjs "folder-with-recordings" [local-sound-folder]',
  );
  process.exitCode = 1;
} else {
  await mkdir(destination, { recursive: true });
  let count = 0;
  for (const track of Object.values(SOUND_TRACKS)) {
    const source = path.resolve(from, track.source);
    try {
      await access(source);
    } catch {
      continue;
    }
    await copyFile(source, path.join(destination, track.file));
    count++;
  }
  console.log(`Imported ${count} local recordings into ${destination}`);
  console.log(
    "Recordings stay on this computer. Restart Workroom to use them.",
  );
}
