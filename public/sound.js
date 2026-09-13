import { SOUND_TRACKS } from "./sound-catalog.js";

const OFFICE = new Set(["typing", "coffee", "printer", "footstep", "ambience"]);
const COOLDOWN = {
  success: 0.65,
  waiting: 1,
  working: 1,
  error: 1,
  typing: 2.6,
  footstep: 0.18,
  coffee: 4,
  printer: 4,
};

/** Event-driven audio. Nothing loads or plays before an explicit browser gesture. */
export class OfficeSound {
  constructor({
    contextFactory = () =>
      new (window.AudioContext || window.webkitAudioContext)(),
    fetcher = (...args) => fetch(...args),
    visible = () => !document.hidden,
  } = {}) {
    this.contextFactory = contextFactory;
    this.fetcher = fetcher;
    this.visible = visible;
    this.flags = {
      enabled: false,
      volume: 0.25,
      office: true,
      motion: true,
      scene: true,
      working: false,
    };
    this.ctx = null;
    this.voices = new Set();
    this.buffers = new Map();
    this.last = new Map();
    this.playedAt = new Map();
    this.sequence = 0;
    this.generation = 0;
    this.ambientPending = false;
  }
  configure(values) {
    const wasEnabled = this.flags.enabled;
    Object.assign(this.flags, values);
    this.flags.volume = Math.max(
      0,
      Math.min(1, Number(this.flags.volume) || 0),
    );
    if (wasEnabled && !this.flags.enabled) {
      this.generation++;
      this.stop();
    }
    if (this.master)
      this.master.gain.setTargetAtTime(
        this.flags.volume,
        this.ctx.currentTime,
        0.025,
      );
    if (!this.officeAllowed()) this.stop("office");
    if (!this.ambientAllowed()) this.stop("ambient");
    else this.ambient();
  }
  officeAllowed() {
    return (
      this.flags.enabled &&
      this.flags.office &&
      this.flags.motion &&
      this.flags.scene &&
      this.visible()
    );
  }
  ambientAllowed() {
    return this.officeAllowed() && this.flags.working;
  }
  async unlock() {
    try {
      if (!this.ctx) {
        this.ctx = this.contextFactory();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.flags.volume;
        this.master.connect(this.ctx.destination);
        this.officeBus = this.ctx.createGain();
        this.officeBus.connect(this.master);
      }
      if (this.ctx.state === "suspended") await this.ctx.resume();
      if (this.flags.enabled) {
        void this.load("success");
        this.ambient();
      }
      return this.ctx.state === "running";
    } catch {
      return false;
    }
  }
  async available() {
    this.manifest ??= this.fetcher("./sound-manifest.json")
      .then((r) => (r.ok ? r.json() : { available: [] }))
      .then(
        (data) => new Set(Array.isArray(data.available) ? data.available : []),
      )
      .catch(() => new Set());
    return this.manifest;
  }
  async load(name) {
    if (!this.ctx || !SOUND_TRACKS[name]) return null;
    if (!this.buffers.has(name))
      this.buffers.set(
        name,
        (async () => {
          try {
            if (!(await this.available()).has(name)) return null;
            const response = await this.fetcher(
              `./sounds/${SOUND_TRACKS[name].file}`,
            );
            if (!response.ok) return null;
            return await this.ctx.decodeAudioData(await response.arrayBuffer());
          } catch {
            return null;
          }
        })(),
      );
    return this.buffers.get(name);
  }
  allowed(group, force) {
    return (
      this.ctx?.state === "running" &&
      (force || this.flags.enabled) &&
      (group !== "office" || this.officeAllowed()) &&
      (group !== "ambient" || this.ambientAllowed())
    );
  }
  stop(group) {
    for (const voice of [...this.voices])
      if (!group || voice.group === group) {
        try {
          voice.source.stop();
        } catch {}
        this.voices.delete(voice);
      }
  }
  duck() {
    if (!this.officeBus) return;
    const now = this.ctx.currentTime;
    this.officeBus.gain.cancelScheduledValues(now);
    this.officeBus.gain.setTargetAtTime(0.2, now, 0.03);
    this.officeBus.gain.setTargetAtTime(1, now + 3.5, 0.25);
  }
  track(source, gain, group) {
    const voice = { source, gain, group };
    this.voices.add(voice);
    source.onended = () => {
      this.voices.delete(voice);
      source.disconnect();
      gain.disconnect();
    };
    source.connect(gain);
    gain.connect(
      group === "office" || group === "ambient" ? this.officeBus : this.master,
    );
    return voice;
  }
  notify(kind) {
    return this.play(kind === "done" ? "success" : kind);
  }
  officeEvent({ kind } = {}) {
    if (OFFICE.has(kind) && kind !== "ambience" && this.officeAllowed())
      return this.play(kind, { group: "office" });
    return Promise.resolve(false);
  }
  async preview(kind = "success") {
    if (!(await this.unlock())) return false;
    this.stop("preview");
    return this.play(kind, { force: true, group: "preview" });
  }
  ambient() {
    if (
      !this.ctx ||
      !this.ambientAllowed() ||
      this.ambientPending ||
      [...this.voices].some((v) => v.group === "ambient")
    )
      return;
    this.ambientPending = true;
    void this.play("ambience", { group: "ambient", loop: true }).finally(() => {
      this.ambientPending = false;
    });
  }
  async play(kind, { force = false, group = "notice", loop = false } = {}) {
    if (!this.allowed(group, force)) return false;
    const now = this.ctx.currentTime;
    const cooldown = COOLDOWN[kind] || 0;
    if (!force && now - (this.last.get(kind) ?? -Infinity) < cooldown)
      return false;
    if (
      group === "office" &&
      [...this.voices].filter((v) => v.group === "office").length >= 4
    )
      return false;
    this.last.set(kind, now);
    const generation = this.generation;
    const sequence = this.sequence++;
    const name =
      kind === "footstep"
        ? sequence % 2
          ? "footstepSoft"
          : "footstepFirm"
        : kind;
    const buffer = await this.load(name);
    // A mute, hidden scene, or disabled animation must cancel a delayed decode too.
    if (generation !== this.generation || !this.allowed(group, force))
      return false;
    if (
      group === "office" &&
      ["footstep", "typing"].includes(kind) &&
      this.ctx.currentTime - now > (kind === "footstep" ? 0.2 : 0.6)
    )
      return false;
    if (
      !force &&
      this.ctx.currentTime - (this.playedAt.get(kind) ?? -Infinity) < cooldown
    )
      return false;
    this.playedAt.set(kind, this.ctx.currentTime);
    if (kind === "success" && group === "notice") {
      this.stop("notice");
      this.duck();
    }
    if (!buffer) {
      this.synth(kind, group, loop);
      return true;
    }
    const spec = SOUND_TRACKS[name];
    const start = this.ctx.currentTime;
    const offset = Math.min(
      Math.max(0, buffer.duration - 0.05),
      spec.offsets?.[sequence % spec.offsets.length] || 0,
    );
    const duration = Math.max(
      0.02,
      Math.min(
        buffer.duration - offset,
        group === "preview" ? Math.min(spec.duration, 3.5) : spec.duration,
      ),
    );
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    const level = spec.gain;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(
      level,
      start + Math.min(0.025, duration / 5),
    );
    if (loop) {
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = buffer.duration;
    } else {
      gain.gain.setValueAtTime(level, start + Math.max(0.03, duration - 0.08));
      gain.gain.linearRampToValueAtTime(0, start + duration);
    }
    this.track(source, gain, group);
    if (loop) source.start(start, offset);
    else source.start(start, offset, duration);
    if (!loop) source.stop(start + duration + 0.01);
    return true;
  }
  tone(frequency, time, duration, level, group, type = "sine") {
    const osc = this.ctx.createOscillator(),
      gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, time);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(level, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    this.track(osc, gain, group);
    osc.start(time);
    osc.stop(time + duration + 0.02);
  }
  noise(time, duration, level, cutoff, group, loop = false) {
    if (!this.noiseBuffer) {
      this.noiseBuffer = this.ctx.createBuffer(
        1,
        this.ctx.sampleRate * 2,
        this.ctx.sampleRate,
      );
      const data = this.noiseBuffer.getChannelData(0);
      let previous = 0,
        seed = 7193;
      for (let i = 0; i < data.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        previous = (previous + ((seed / 4294967296) * 2 - 1) * 0.08) / 1.08;
        data[i] = previous * 3;
      }
    }
    const source = this.ctx.createBufferSource(),
      gain = this.ctx.createGain(),
      filter = this.ctx.createBiquadFilter();
    source.buffer = this.noiseBuffer;
    source.loop = loop;
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(
      level,
      time + Math.min(0.035, duration / 4),
    );
    if (!loop) gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    const voice = this.track(source, gain, group);
    source.disconnect();
    source.connect(filter);
    filter.connect(gain);
    const end = source.onended;
    source.onended = () => {
      end();
      filter.disconnect();
    };
    source.start(time);
    if (!loop) source.stop(time + duration + 0.02);
    return voice;
  }
  synth(kind, group, loop) {
    const now = this.ctx.currentTime;
    if (kind === "typing") {
      for (let i = 0; i < 5; i++)
        this.noise(now + i * 0.095, 0.055, 0.07, 2800, group);
    } else if (kind === "footstep") {
      this.noise(now, 0.14, 0.18, 420, group);
      this.tone(83, now, 0.1, 0.06, group, "triangle");
    } else if (kind === "coffee") {
      this.noise(now, 2.8, 0.12, 750, group);
      this.tone(110, now, 2, 0.025, group);
    } else if (kind === "printer") {
      for (let i = 0; i < 3; i++) {
        this.noise(now + i * 0.65, 0.45, 0.08, 1300, group);
        this.tone(145 + i * 25, now + i * 0.65, 0.4, 0.025, group, "triangle");
      }
    } else if (kind === "ambience") {
      this.noise(now, 3, 0.035, 650, group, loop);
    } else {
      const notes =
        kind === "success"
          ? [523.25, 659.25, 783.99]
          : kind === "waiting"
            ? [587.33, 440]
            : kind === "error"
              ? [220, 174.61]
              : kind === "enabled"
                ? [660]
                : [392, 523.25];
      notes.forEach((frequency, index) =>
        this.tone(
          frequency,
          now + index * 0.11,
          kind === "enabled" ? 0.09 : 0.25,
          0.16,
          group,
        ),
      );
    }
  }
  destroy() {
    this.generation++;
    this.stop();
    void this.ctx?.close();
  }
}
