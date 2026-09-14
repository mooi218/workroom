// Shared with the browser. Keep this module free of Node, storage and network APIs.
export const MAX_DISPLAY_SELECTION_KEYS = 10_000;
export const MAX_TASK_SELECTION_KEY_LENGTH = 512;
const STATUSES = new Set([
  "",
  "working",
  "waiting",
  "done",
  "idle",
  "error",
  "unknown",
]);
const FIELDS = new Set(["version", "mode", "taskKeys", "status"]);
const keySets = new WeakMap();

export class DisplaySelectionError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "DisplaySelectionError";
    this.code = code;
  }
}

function invalid() {
  throw new DisplaySelectionError(
    "INVALID_DISPLAY_SELECTION",
    "Display selection must contain a valid version, mode, task keys and status.",
  );
}

function identityKey(source, id) {
  if (
    typeof source !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(source) ||
    typeof id !== "string" ||
    id.length > MAX_TASK_SELECTION_KEY_LENGTH ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(id)
  )
    return null;
  const key = JSON.stringify([source, id]);
  return key.length <= MAX_TASK_SELECTION_KEY_LENGTH ? key : null;
}

/** Canonical job identity. Several department seats for one job share this key. */
export function taskSelectionKey(task) {
  return identityKey(task?.source, task?.taskId ?? task?.id);
}

function normalizeKey(value) {
  if (typeof value !== "string" || value.length > MAX_TASK_SELECTION_KEY_LENGTH)
    invalid();
  let pair;
  try {
    pair = JSON.parse(value);
  } catch {
    invalid();
  }
  if (!Array.isArray(pair) || pair.length !== 2) invalid();
  const key = identityKey(pair[0], pair[1]);
  if (!key) invalid();
  return key;
}

function freezeSelection(mode, taskKeys, status) {
  const result = Object.freeze({
    version: 1,
    mode,
    taskKeys: Object.freeze(taskKeys),
    status,
  });
  keySets.set(result, new Set(taskKeys));
  return result;
}

export const DEFAULT_DISPLAY_SELECTION = freezeSelection("all", [], "working");

/** Strict validation; absence/corruption must not silently become "show all".
 * Returns an immutable, deduplicated value. Keys are retained even in all mode.
 */
export function normalizeDisplaySelection(input) {
  if (input && keySets.has(input)) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  if (Number.isInteger(input.version) && input.version !== 1) {
    throw new DisplaySelectionError(
      "UNSUPPORTED_DISPLAY_SELECTION_VERSION",
      "This display selection version is not supported.",
    );
  }
  if (
    input.version !== 1 ||
    Object.keys(input).length !== 4 ||
    Object.keys(input).some((key) => !FIELDS.has(key)) ||
    !["all", "selected"].includes(input.mode) ||
    !STATUSES.has(input.status) ||
    !Array.isArray(input.taskKeys) ||
    input.taskKeys.length > MAX_DISPLAY_SELECTION_KEYS
  )
    invalid();
  const taskKeys = [...new Set(Array.from(input.taskKeys, normalizeKey))];
  return freezeSelection(input.mode, taskKeys, input.status);
}

/** Job selection only; the caller applies the separate status filter.
 * Normalize once when state changes so repeated checks use the cached Set.
 */
export function matchesDisplaySelection(task, selection) {
  const normalized = normalizeDisplaySelection(selection);
  const key = taskSelectionKey(task);
  if (!key) return false;
  return normalized.mode === "all" || keySets.get(normalized).has(key);
}
