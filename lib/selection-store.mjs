import { open, mkdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_DISPLAY_SELECTION,
  DisplaySelectionError,
  normalizeDisplaySelection,
} from "./selection-model.mjs";

export const DISPLAY_SELECTION_FILENAME = "display-selection.json";
export const MAX_DISPLAY_SELECTION_FILE_BYTES = 16 * 1024 * 1024;
const queues = new Map();

export class SelectionStoreError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "SelectionStoreError";
    this.code = code;
  }
}

const readError = (cause) =>
  new SelectionStoreError(
    "DISPLAY_SELECTION_READ_FAILED",
    "The saved display selection could not be read.",
    cause,
  );
const invalidSaved = (cause) =>
  new SelectionStoreError(
    "INVALID_SAVED_DISPLAY_SELECTION",
    "The saved display selection is invalid and was left unchanged.",
    cause,
  );

/** Only this fixed metadata file is managed; unrelated application files remain untouched. */
export function createSelectionStore({ dataDir } = {}) {
  if (typeof dataDir !== "string" || !dataDir.trim())
    throw new TypeError("A selection data directory is required.");
  const directory = path.resolve(dataDir);
  const filename = path.join(directory, DISPLAY_SELECTION_FILENAME);
  // One queue per path also serializes separate store instances in this process.
  const queueKey =
    process.platform === "win32" ? filename.toLowerCase() : filename;
  function enqueue(operation) {
    const result = (queues.get(queueKey) || Promise.resolve()).then(operation);
    const settled = result.catch(() => undefined);
    queues.set(queueKey, settled);
    settled.then(() => {
      if (queues.get(queueKey) === settled) queues.delete(queueKey);
    });
    return result;
  }

  async function readSaved() {
    let handle;
    try {
      handle = await open(filename, "r");
    } catch (error) {
      if (error.code === "ENOENT") return DEFAULT_DISPLAY_SELECTION;
      throw readError(error);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw readError();
      if (info.size > MAX_DISPLAY_SELECTION_FILE_BYTES) {
        throw new SelectionStoreError(
          "DISPLAY_SELECTION_FILE_TOO_LARGE",
          "The saved display selection is too large and was left unchanged.",
        );
      }
      // A bounded read also detects a file growing during this read. Normally
      // another reader sees either the old or new file because writes rename.
      const bytes = Buffer.alloc(info.size + 1);
      let used = 0;
      while (used < bytes.length) {
        const result = await handle.read(
          bytes,
          used,
          bytes.length - used,
          used,
        );
        if (!result.bytesRead) break;
        used += result.bytesRead;
      }
      if (used > info.size) throw readError();
      let parsed;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, used),
          ),
        );
      } catch (error) {
        throw invalidSaved(error);
      }
      try {
        return normalizeDisplaySelection(parsed);
      } catch (error) {
        if (error.code === "UNSUPPORTED_DISPLAY_SELECTION_VERSION") throw error;
        throw invalidSaved(error);
      }
    } catch (error) {
      if (
        error instanceof SelectionStoreError ||
        error instanceof DisplaySelectionError
      )
        throw error;
      throw readError(error);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    read() {
      return enqueue(readSaved);
    },
    async write(input) {
      // Capture the caller's value before waiting, rather than retaining its draft.
      const selection = normalizeDisplaySelection(input);
      const bytes = Buffer.from(`${JSON.stringify(selection)}\n`, "utf8");
      if (bytes.length > MAX_DISPLAY_SELECTION_FILE_BYTES)
        throw new SelectionStoreError(
          "DISPLAY_SELECTION_FILE_TOO_LARGE",
          "The display selection is too large.",
        );
      return enqueue(async () => {
        // In particular, never replace a future-version/corrupt file with a
        // default or a version-1 save that could silently erase existing choices.
        await readSaved();
        let temporary, handle;
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          temporary = path.join(
            directory,
            `.${DISPLAY_SELECTION_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
          );
          handle = await open(temporary, "wx", 0o600);
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          handle = null;
          await rename(temporary, filename);
          temporary = null;
          return selection;
        } catch (error) {
          throw new SelectionStoreError(
            "DISPLAY_SELECTION_WRITE_FAILED",
            "The display selection could not be saved.",
            error,
          );
        } finally {
          if (handle) await handle.close().catch(() => undefined);
          if (temporary) await unlink(temporary).catch(() => undefined);
        }
      });
    },
  };
}
