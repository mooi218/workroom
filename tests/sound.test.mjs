import test from "node:test";
import assert from "node:assert/strict";
import { OfficeSound } from "../public/sound.js";

function environment(available = [], decode) {
  const nodes = [],
    requests = [];
  const param = () => ({
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime() {},
    cancelScheduledValues() {},
  });
  const node = () => ({ connect() {}, disconnect() {} });
  const source = () => {
    const result = {
      ...node(),
      frequency: param(),
      start() {
        this.started = true;
      },
      stop() {
        this.stopped = true;
      },
    };
    nodes.push(result);
    return result;
  };
  const context = {
    state: "running",
    currentTime: 10,
    sampleRate: 100,
    destination: node(),
    resume: async () => {},
    close: async () => {},
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), frequency: param() }),
    createOscillator: source,
    createBufferSource: source,
    createBuffer: (_, count) => ({
      getChannelData: () => new Float32Array(count),
    }),
    decodeAudioData: decode || (async () => ({ duration: 10 })),
  };
  let created = 0;
  const sound = new OfficeSound({
    contextFactory: () => {
      created++;
      return context;
    },
    visible: () => true,
    fetcher: async (url) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({ available }),
        arrayBuffer: async () => new ArrayBuffer(1),
      };
    },
  });
  return { sound, nodes, requests, context, created: () => created };
}

test("muted/default office does not create an audio context or fetch recordings", async () => {
  const e = environment(["success"]);
  e.sound.configure({ working: true });
  assert.equal(await e.sound.notify("done"), false);
  assert.equal(await e.sound.officeEvent({ kind: "typing" }), false);
  assert.equal(e.created(), 0);
  assert.deepEqual(e.requests, []);
});

test("muting while a completion recording decodes prevents delayed playback", async () => {
  let finishDecode;
  const e = environment(
    ["success"],
    () =>
      new Promise((resolve) => {
        finishDecode = resolve;
      }),
  );
  e.sound.configure({ enabled: true });
  await e.sound.unlock();
  const pending = e.sound.notify("done");
  for (let i = 0; i < 8 && !finishDecode; i++) await Promise.resolve();
  assert.ok(finishDecode);
  e.sound.configure({ enabled: false });
  finishDecode({ duration: 3.4 });
  assert.equal(await pending, false);
  assert.equal(
    e.nodes.some((node) => node.started),
    false,
  );
});

test("footsteps coalesce and office mute stops them while completion stays available", async () => {
  const e = environment(["footstepSoft", "footstepFirm", "success"]);
  e.sound.configure({ enabled: true });
  await e.sound.unlock();
  assert.equal(await e.sound.officeEvent({ kind: "footstep" }), true);
  assert.equal(await e.sound.officeEvent({ kind: "footstep" }), false);
  e.sound.configure({ office: false });
  assert.ok(e.nodes.every((node) => node.stopped));
  assert.equal(await e.sound.officeEvent({ kind: "coffee" }), false);
  assert.equal(await e.sound.notify("done"), true);
  assert.ok(e.requests.includes("./sounds/success.mp3"));
  assert.equal(
    [...e.sound.voices].filter((voice) => voice.group === "notice").length,
    1,
  );
});

test("explicit preview works while muted and missing recordings use built-in sounds", async () => {
  const e = environment();
  assert.equal(await e.sound.preview("success"), true);
  assert.equal(e.sound.flags.enabled, false);
  assert.equal(e.nodes.filter((node) => node.started).length, 3);
  assert.deepEqual(e.requests, ["./sound-manifest.json"]);
});
