import { t, roleName } from "./i18n.js";
const STATUS_COLORS = {
  working: "#659875",
  waiting: "#d5a253",
  done: "#7a9dbc",
  idle: "#a1a590",
  error: "#be6d62",
  unknown: "#a1a590",
};
const DARK = {
  "#ced4c5": "#263832",
  "#d4d8c9": "#33443b",
  "#d0d5c5": "#304037",
  "#aab09a": "#4e5c48",
  "#e5e5ce": "#67705a",
  "#b6bea7": "#435440",
  "#98a58f": "#596a50",
  "#e0dfc5": "#3e5041",
  "#e5e2cb": "#3b4b3c",
  "#e9e8d4": "#53634d",
  "#c0c8b0": "#78856a",
  "#d4d4b866": "#7a896622",
  "#c6cebd55": "#24362c55",
  "#c7cbb6": "#576a4e",
  "#b0b6a0": "#405440",
};
const GRAPHITE = {
  "#ced4c5": "#1e2025",
  "#d4d8c9": "#292c32",
  "#d0d5c5": "#24272d",
  "#aab09a": "#51555e",
  "#e5e5ce": "#626874",
  "#b6bea7": "#353a43",
  "#98a58f": "#4d5460",
  "#e0dfc5": "#363b45",
  "#e5e2cb": "#30353e",
  "#e9e8d4": "#454c59",
  "#c0c8b0": "#6c7584",
  "#d4d4b866": "#8290a122",
  "#c6cebd55": "#12182255",
  "#c7cbb6": "#454d5a",
  "#b0b6a0": "#333a45",
};
const LIGHT = {
  "#ced4c5": "#c9d3e3",
  "#d4d8c9": "#dce3ef",
  "#d0d5c5": "#d3dce9",
  "#aab09a": "#a3b5cf",
  "#e5e5ce": "#e7edf6",
  "#b6bea7": "#aabbd2",
  "#98a58f": "#8c9fb9",
  "#e0dfc5": "#e4e8f1",
  "#e5e2cb": "#eaf0f7",
  "#e9e8d4": "#f5f7fc",
  "#c0c8b0": "#b4c6de",
  "#d4d4b866": "#b8c7dc55",
  "#c6cebd55": "#a3b7d855",
  "#c7cbb6": "#a8bedb",
  "#b0b6a0": "#809ab9",
};
const hash = (value) =>
  [...String(value)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
const SKIN = ["#d4ad80", "#b78863", "#e0bf93", "#996a4e"];
const HAIR = ["#514b3e", "#353e37", "#766043", "#665b48"];
const blendHex = (color, base, amount) => {
  const a = /^#[0-9a-f]{6}$/i.test(color) ? color : "#637a91";
  return (
    "#" +
    [1, 3, 5]
      .map((i) =>
        Math.round(
          parseInt(a.slice(i, i + 2), 16) * amount +
            parseInt(base.slice(i, i + 2), 16) * (1 - amount),
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
};

export class Office {
  constructor({ canvas, overlay, world, viewport, onSelect }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.overlay = overlay;
    this.world = world;
    this.viewport = viewport;
    this.onSelect = onSelect;
    this.motion = true;
    this.wandering = false;
    this.frame = 0;
    this.time = 0;
    this.scale = 1;
    this.width = 1120;
    this.height = 850;
    this.rooms = [];
    this.seats = [];
    this.selected = null;
    this.visits = new Map();
    this.nextDeparture = [];
    this.departureNumber = [];
    // A shared, low-frequency animation clock. Hidden tabs and motion-off consume no drawing work.
    this.timer = setInterval(() => {
      if (this.motion && !document.hidden) {
        this.frame++;
        this.time += 0.1;
        this.draw();
      }
    }, 100);
    this.resize = new ResizeObserver(() => {
      const columns = this.columnCount();
      if (this.tasks && columns !== this.columns)
        this.setData(this.tasks, this.roles, this.selected);
      else this.fit();
    });
    this.resize.observe(viewport);
    this.onScroll = () => this.draw();
    viewport.addEventListener("scroll", this.onScroll, { passive: true });
  }
  columnCount() {
    return this.viewport.clientWidth >= 880
      ? 3
      : this.viewport.clientWidth >= 590
        ? 2
        : 1;
  }
  setData(tasks, roles, selected) {
    this.selected = selected;
    this.roles = roles;
    this.tasks = tasks;
    const previousColumns = this.columns;
    this.columns = this.columnCount();
    this.width = this.columns * 358 + 38;
    if (previousColumns !== this.columns) this.visits.clear();
    const cols = Array(this.columns).fill(188),
      roomWidth = 340,
      gap = 18;
    this.rooms = [];
    this.seats = [];
    roles.forEach((role, index) => {
      const jobs = tasks.filter((t) => t.roleId === role.id);
      const col = cols.indexOf(Math.min(...cols));
      const x = 28 + col * (roomWidth + gap),
        y = cols[col];
      const height = jobs.length ? 54 + Math.ceil(jobs.length / 2) * 146 : 160;
      const room = { x, y, w: roomWidth, h: height, role, jobs, index, col };
      this.rooms.push(room);
      cols[col] += height + 14;
      jobs.forEach((task, i) => {
        const key = `${task.id || task.taskId}:${role.id}`;
        this.seats.push({
          x: x + 24 + (i % 2) * 150,
          y: y + 84 + Math.floor(i / 2) * 146,
          w: 138,
          h: 158,
          task,
          role,
          room,
          key,
          seed: hash(key),
        });
      });
    });
    const byKey = new Map(this.seats.map((seat) => [seat.key, seat]));
    // A filter, a new role, or a status change must never leave a ghost avatar behind.
    for (const [key, visit] of this.visits) {
      const seat = byKey.get(key);
      if (
        !seat ||
        seat.x !== visit.seat.x ||
        seat.y !== visit.seat.y ||
        seat.task.status !== visit.status
      )
        this.visits.delete(key);
      else visit.seat = seat;
    }
    this.wanderCandidates = Array.from({ length: this.columns }, (_, col) =>
      this.seats.filter(
        (seat) =>
          seat.room.col === col &&
          !["error", "unknown"].includes(seat.task.status),
      ),
    );
    this.height = Math.max(620, ...cols) + 30;
    this.canvas.width = this.width;
    this.overlay.replaceChildren();
    for (const seat of this.seats) {
      const b = document.createElement("button");
      b.className = `seat${seat.task.taskId === selected ? " selected" : ""}`;
      b.style.cssText = `left:${seat.x}px;top:${seat.y - 48}px;width:${seat.w}px;height:${seat.h}px`;
      b.setAttribute(
        "aria-label",
        `${roleName(seat.role)}: ${seat.task.title}`,
      );
      b.title = seat.task.title;
      b.onclick = () => this.onSelect(seat.task.taskId || seat.task.id);
      const label = document.createElement("span");
      label.className = "speech-bubble";
      const dot = document.createElement("i");
      dot.style.background =
        STATUS_COLORS[seat.task.status] || STATUS_COLORS.unknown;
      const words = document.createElement("span");
      words.textContent = seat.task.title;
      label.append(dot, words);
      b.append(label);
      this.overlay.append(b);
      seat.button = b;
    }
    this.fit();
    this.draw();
  }
  setMotion(value) {
    this.motion = Boolean(value);
    this.draw();
  }
  setWandering(value) {
    const enabled = Boolean(value);
    if (enabled !== this.wandering) {
      this.wandering = enabled;
      this.visits.clear();
      this.nextDeparture = Array.from(
        { length: 3 },
        (_, col) => this.time + 1.5 + col * 3,
      );
      this.departureNumber = [0, 0, 0];
    }
    this.draw();
  }
  setTheme(theme) {
    this.dark = theme === true || theme === "dark" || theme === "graphite";
    this.palette = theme === "graphite" ? GRAPHITE : this.dark ? DARK : LIGHT;
    this.draw();
  }
  fit() {
    const focused = this.viewport.closest(".focus-mode");
    const widthScale = this.viewport.clientWidth / this.width;
    const heightScale = this.viewport.clientHeight / this.height;
    this.setScale(
      focused
        ? Math.min(1.5, widthScale, heightScale)
        : Math.min(1, widthScale),
    );
  }
  setScale(value) {
    this.scale = Math.max(0.5, Math.min(1.5, value));
    this.world.style.width = `${this.width * this.scale}px`;
    this.world.style.height = `${this.height * this.scale}px`;
    this.canvas.style.width = `${this.width * this.scale}px`;
    this.overlay.style.width = `${this.width}px`;
    this.overlay.style.height = `${this.height}px`;
    this.overlay.style.transform = `scale(${this.scale})`;
    this.overlay.style.transformOrigin = "0 0";
    document.querySelector("#zoom-label").textContent =
      `${Math.round(this.scale * 100)}%`;
    this.draw();
  }
  rect(x, y, w, h, color) {
    this.ctx.fillStyle = this.palette?.[color] || color;
    this.ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }
  line(x, y, w, h, color) {
    this.rect(x, y, w, h, color);
  }
  text(str, x, y, size = 16, color = "#4c6050", weight = "500") {
    this.ctx.font = `${weight} ${size}px "IBM Plex Sans", "Noto Sans JP", "Segoe UI", sans-serif`;
    this.ctx.fillStyle =
      this.dark &&
      [
        "#4c6050",
        "#576b55",
        "#89977c",
        "#8c9a7e",
        "#849577",
        "#657863",
      ].includes(color)
        ? "#d5dec5"
        : color;
    this.ctx.fillText(str, x, y);
  }
  plant(x, y, scale = 1) {
    const c = this.ctx;
    c.save();
    c.translate(x, y);
    c.scale(scale, scale);
    this.rect(-15, 9, 34, 10, "#58685722");
    this.rect(-10, -4, 23, 22, "#787b6b");
    this.rect(-12, -8, 27, 8, "#acac91");
    this.rect(-8, -6, 19, 5, "#414e36");
    this.rect(-2, -31, 5, 27, "#6f7350");
    this.rect(-19, -30, 18, 15, "#648256");
    this.rect(1, -39, 17, 24, "#789664");
    this.rect(-7, -48, 15, 24, "#88a773");
    this.rect(7, -22, 18, 12, "#668756");
    this.rect(-16, -21, 15, 12, "#7d9d69");
    this.rect(-8, -34, 9, 14, "#9cb581");
    this.rect(6, -32, 6, 6, "#b1c18a");
    c.restore();
  }
  window(x, y, w) {
    this.rect(x + 3, y + 5, w, 64, "#424f5333");
    this.rect(x, y, w, 61, "#8b9b97");
    this.rect(x + 4, y + 4, w - 8, 49, "#d5e6e6");
    this.rect(x + 8, y + 7, w - 16, 40, "#b9d7dd");
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(x + 8, y + 7, w - 16, 40);
    c.clip();
    for (let k = 0; k < 8; k++) {
      const h = 14 + ((k * 13) % 28);
      this.rect(
        x + (k * w) / 7,
        y + 47 - h,
        17,
        h,
        k % 2 ? "#a4bcc7" : "#afc8d0",
      );
      this.rect(x + 3 + (k * w) / 7, y + 50 - h, 3, 4, "#dae6df");
    }
    this.rect(x + w * 0.3, y + 7, 14, 39, "#eaf2e580");
    this.rect(x + w * 0.38, y + 7, 5, 39, "#eaf2e580");
    c.restore();
    this.rect(x + w / 2 - 2, y + 4, 4, 49, "#eef0de");
    this.rect(x - 3, y + 53, w + 6, 8, "#dde1ce");
    this.rect(x - 3, y + 61, w + 6, 3, "#a1ac9b");
  }
  shelf(x, y, w = 67) {
    this.rect(x + 4, y + 6, w, 56, "#515f4033");
    this.rect(x, y, w, 55, "#a8956b");
    this.rect(x + 4, y + 3, w - 8, 46, "#686e51");
    const colors = ["#829aa6", "#b88e68", "#aaa475", "#668577", "#b4b99a"];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 7; j++) {
        this.rect(x + 7 + j * 7, y + 7 + i * 23, 5, 17, colors[(j + i) % 5]);
        this.rect(x + 8 + j * 7, y + 10 + i * 23, 3, 1, "#d8dbc3");
      }
      this.rect(x, y + 25 + i * 24, w, 4, "#b9a981");
    }
    this.rect(x, y + 53, 5, 5, "#6f765c");
    this.rect(x + w - 5, y + 53, 5, 5, "#6f765c");
  }
  rug(x, y, w, h) {
    this.rect(x + 3, y + 3, w, h, "#586b4822");
    this.rect(x, y, w, h, "#a2ad86");
    this.rect(x + 5, y + 5, w - 10, h - 10, "#b7bca0");
    this.rect(x + 9, y + 9, w - 18, 2, "#98a383");
    this.rect(x + 9, y + h - 11, w - 18, 2, "#98a383");
  }
  emptyChair(x, y, color = "#527d9c") {
    this.rect(x - 13, y + 12, 29, 8, "#344d5d22");
    this.rect(x - 12, y - 20, 26, 21, "#314a5b");
    this.rect(x - 9, y - 18, 20, 16, color);
    this.rect(x - 9, y - 17, 20, 2, blendHex(color, "#f0f5f6", 0.55));
    this.rect(x - 14, y, 29, 11, "#314a5b");
    this.rect(x - 11, y + 1, 23, 6, color);
    this.rect(x - 10, y + 11, 3, 9, "#455b61");
    this.rect(x + 10, y + 11, 3, 9, "#455b61");
  }
  workTable(x, y, w, h = 30) {
    this.rect(x + 4, y + 9, w, h + 7, "#34506422");
    this.rect(x + 6, y + h, 5, 14, "#56626a");
    this.rect(x + w - 11, y + h, 5, 14, "#56626a");
    this.rect(x, y, w, h, "#947746");
    this.rect(x + 2, y + 2, w - 4, h - 6, "#caab75");
    this.rect(x + 3, y + 2, w - 6, 3, "#edcf95");
    this.rect(x + 4, y + h - 5, w - 8, 3, "#b0905c");
    this.rect(x + 12, y + 12, Math.max(12, w * 0.3), 1, "#b99863");
    this.rect(x + w * 0.65, y + h - 12, Math.max(8, w * 0.2), 1, "#b99863");
  }
  smallMonitor(x, y, w = 43) {
    this.rect(x, y, w, 29, "#39546a");
    this.rect(x + 3, y + 3, w - 6, 22, "#84b4c4");
    this.rect(x + 6, y + 6, w - 12, 3, "#cde8e5");
    this.rect(x + 6, y + 13, w - 20, 2, "#b5d7db");
    this.rect(x + w / 2 - 2, y + 29, 5, 5, "#566b75");
    this.rect(x + w / 2 - 10, y + 34, 21, 3, "#657781");
  }
  wallBoard(x, y, w, h, kind = "notes") {
    this.rect(x + 3, y + 4, w, h, "#3f53692a");
    this.rect(x, y, w, h, "#aa9875");
    this.rect(x + 2, y + 2, w - 4, h - 4, "#f4efdc");
    this.rect(x + 4, y + 4, w - 8, 2, "#fff8df");
    if (kind === "chart") {
      this.rect(x + 9, y + h - 11, w - 17, 2, "#839eac");
      for (let i = 0; i < 3; i++)
        this.rect(
          x + 10 + (i * (w - 20)) / 3,
          y + h - 18 - i * 7,
          Math.max(4, (w - 25) / 3),
          7 + i * 7,
          ["#78a7b6", "#629296", "#d0ac73"][i],
        );
    } else if (kind === "writing") {
      for (let i = 0; i < 6; i++)
        this.rect(
          x + 9,
          y + 12 + i * 6,
          w - 18 - (i % 3) * 5,
          2,
          i ? "#9aacae" : "#52788c",
        );
    } else if (kind === "design") {
      for (let i = 0; i < 6; i++)
        this.rect(
          x + 8 + ((i % 3) * (w - 17)) / 3,
          y + 11 + Math.floor(i / 3) * 17,
          (w - 24) / 3,
          12,
          ["#ca8d9c", "#cead67", "#79a2bc", "#90ad84", "#a094b4", "#6c9b9c"][i],
        );
    } else {
      this.rect(x + 8, y + 11, w - 16, 2, "#7793a5");
      const colors = ["#dfba73", "#8eafbf", "#b6c78e"];
      for (let i = 0; i < 3; i++) {
        this.rect(
          x + 8 + (i * (w - 15)) / 3,
          y + 21 + (i % 2) * 7,
          Math.max(7, (w - 24) / 3),
          16,
          colors[i],
        );
        this.rect(
          x + 10 + (i * (w - 15)) / 3,
          y + 25 + (i % 2) * 7,
          Math.max(3, (w - 37) / 3),
          1,
          "#687f89",
        );
      }
    }
  }
  emptyRoom(room) {
    const { x, y, role } = room,
      id = role.id;
    const chairColor = blendHex(role.color, "#426580", 0.4);
    this.plant(x + 22, y + 125, 0.5);
    this.plant(x + 315, y + 132, 0.55);
    if (id === "pr") {
      this.emptyChair(x + 93, y + 89, "#6b96a5");
      this.emptyChair(x + 183, y + 89, "#6b96a5");
      this.rect(x + 103, y + 128, 87, 12, "#3e556633");
      this.rect(x + 109, y + 120, 7, 23, "#6a725e");
      this.rect(x + 180, y + 120, 7, 23, "#6a725e");
      this.rect(x + 102, y + 112, 89, 17, "#967b53");
      this.rect(x + 108, y + 107, 77, 27, "#b69a6f");
      this.rect(x + 116, y + 104, 61, 31, "#cbb084");
      this.rect(x + 133, y + 112, 19, 12, "#729aab");
      this.rect(x + 136, y + 114, 13, 2, "#e6e5d2");
      this.cup(x + 159, y + 114);
      this.wallBoard(x + 245, y + 56, 46, 65, "chart");
    } else if (id === "sales" || id === "planning") {
      for (const dx of [90, 138, 186])
        this.emptyChair(x + dx, y + 77, chairColor);
      this.workTable(x + 67, y + 87, 165, 37);
      for (const dx of [91, 139, 187]) {
        this.rect(x + dx - 8, y + 95, 17, 12, "#608ca8");
        this.rect(x + dx - 5, y + 98, 11, 2, "#dce8e4");
        this.emptyChair(x + dx, y + 132, chairColor);
      }
      this.wallBoard(
        x + 251,
        y + 57,
        48,
        65,
        id === "sales" ? "chart" : "notes",
      );
    } else if (id === "writing") {
      this.shelf(x + 36, y + 63, 67);
      this.workTable(x + 123, y + 91, 104, 32);
      this.emptyChair(x + 174, y + 132, chairColor);
      this.rect(x + 143, y + 96, 23, 15, "#f1ebd7");
      this.rect(x + 146, y + 100, 17, 2, "#a4afb0");
      this.rect(x + 181, y + 99, 22, 11, "#87a29b");
      this.cup(x + 208, y + 95);
      this.wallBoard(x + 249, y + 60, 47, 66, "writing");
    } else if (id === "design") {
      this.workTable(x + 74, y + 88, 142, 38);
      this.wallBoard(x + 81, y + 59, 116, 49, "design");
      this.emptyChair(x + 145, y + 132, chairColor);
      this.wallBoard(x + 249, y + 59, 46, 62, "design");
      this.rect(x + 202, y + 97, 3, 18, "#7b9ab5");
      this.rect(x + 206, y + 94, 2, 21, "#d5b563");
    } else if (id === "research") {
      this.workTable(x + 67, y + 94, 156, 31);
      this.emptyChair(x + 148, y + 133, chairColor);
      this.wallBoard(x + 42, y + 53, 46, 52, "chart");
      this.shelf(x + 251, y + 67, 57);
      this.rect(x + 128, y + 99, 45, 18, "#ded6bd");
      this.rect(x + 130, y + 98, 19, 16, "#f4efde");
      this.rect(x + 151, y + 98, 19, 16, "#eee8d5");
      for (let i = 0; i < 3; i++) {
        this.rect(x + 133, y + 102 + i * 4, 13, 1, "#a5b4ae");
        this.rect(x + 154, y + 102 + i * 4, 13, 1, "#a5b4ae");
      }
      this.rect(x + 186, y + 108, 24, 5, "#526e79");
      this.rect(x + 194, y + 83, 6, 28, "#718d94");
      this.rect(x + 185, y + 81, 16, 8, "#486a79");
      this.rect(x + 182, y + 87, 7, 8, "#8cabb0");
    } else if (id === "engineering" || id === "operations") {
      this.workTable(x + 93, y + 93, 143, 33);
      this.smallMonitor(x + 129, y + 60, 54);
      this.emptyChair(x + 162, y + 133, chairColor);
      this.rect(x + 141, y + 101, 37, 7, "#687d88");
      this.rect(x + 193, y + 97, 22, 14, "#e9e5d3");
      const cx = id === "engineering" ? x + 259 : x + 41;
      this.rect(cx, y + 58, 37, 73, "#627787");
      this.rect(cx + 3, y + 61, 31, 66, "#a6b6bc");
      for (let i = 0; i < 3; i++) {
        this.rect(
          cx + 5,
          y + 65 + i * 20,
          27,
          17,
          id === "engineering" ? "#344f63" : "#b9c7c8",
        );
        this.rect(
          cx + 16,
          y + 71 + i * 20,
          8,
          2,
          id === "engineering" ? "#c1cfa0" : "#677f8f",
        );
      }
      if (id === "engineering") this.wallBoard(x + 38, y + 54, 43, 48, "notes");
      else {
        this.rect(x + 262, y + 59, 29, 29, "#577486");
        this.rect(x + 266, y + 62, 21, 23, "#eff0db");
        this.rect(x + 275, y + 66, 2, 10, "#4b667a");
        this.rect(x + 275, y + 73, 7, 2, "#4b667a");
      }
    } else {
      this.rug(x + 80, y + 87, 175, 51);
      this.emptyChair(x + 116, y + 111, chairColor);
      this.emptyChair(x + 218, y + 111, chairColor);
      this.workTable(x + 145, y + 104, 45, 26);
      this.cup(x + 153, y + 112);
      this.wallBoard(x + 127, y + 53, 76, 48, "notes");
    }
  }
  woodSign(x, y, w, compact = false) {
    const h = compact ? 39 : 65;
    this.rect(x + 4, y + 6, w, h, "#344d5c2a");
    this.rect(x + 6, y + h - 2, 5, 10, "#6c6048");
    this.rect(x + w - 12, y + h - 2, 5, 10, "#6c6048");
    this.rect(x, y, w, h, "#806846");
    this.rect(x + 2, y + 2, w - 4, h - 4, "#c9a977");
    this.rect(x + 4, y + 3, w - 8, 3, "#ecd3a1");
    for (let line = 13; line < h - 4; line += 11)
      this.rect(x + 4, y + line, w - 8, 1, "#b99b6d");
    this.rect(x + 6, y + 9, 3, 3, "#92794f");
    this.rect(x + w - 10, y + 9, 3, 3, "#92794f");
    const c = this.ctx;
    c.save();
    c.textAlign = "center";
    this.text(
      "WORKROOM",
      x + w / 2,
      y + (compact ? 26 : 31),
      compact ? 20 : 25,
      "#17344b",
      "750",
    );
    if (!compact)
      this.text(
        "GOOD PEOPLE · GOOD WORK",
        x + w / 2,
        y + 51,
        14,
        "#243e4d",
        "650",
      );
    c.restore();
  }
  officeFrame(top, height) {
    this.rect(7, 6, this.width - 14, 5, "#425c6a");
    this.rect(7, 9, 18, this.height - 16, "#98a58f");
    this.rect(this.width - 25, 9, 18, this.height - 16, "#98a58f");
    this.rect(7, 9, 3, this.height - 16, "#425c6a");
    this.rect(this.width - 10, 9, 3, this.height - 16, "#425c6a");
    this.rect(23, 10, 3, this.height - 18, "#536775");
    this.rect(this.width - 26, 10, 3, this.height - 18, "#536775");
    for (
      let py = Math.max(12, Math.floor(top / 14) * 14);
      py < Math.min(this.height - 7, top + height);
      py += 14
    ) {
      this.rect(11, py, 11, 1, "#c0c8b0");
      this.rect(this.width - 22, py, 11, 1, "#c0c8b0");
    }
    for (
      let py = 102 + Math.max(0, Math.floor((top - 102) / 184)) * 184;
      py < Math.min(this.height - 55, top + height);
      py += 184
    ) {
      for (const px of [13, this.width - 21]) {
        this.rect(px, py, 9, 36, "#354f62");
        this.rect(px + 2, py + 3, 5, 3, "#f0dfaf");
        this.rect(px + 3, py + 8, 3, 4, "#d8ba75");
        this.rect(px + 2, py + 30, 5, 2, "#849aa5");
      }
    }
    this.rect(8, this.height - 7, this.width - 16, 4, "#425c6a");
  }
  lobbyLayout() {
    if (this.columns === 1)
      return {
        sofaX: 39,
        sofaY: 95,
        table: false,
        coffeeX: 211,
        coffeeW: 78,
        printerX: 319,
        printerW: 44,
        lounge: { x: 101, y: 140 },
        coffee: { x: 254, y: 149 },
        printer: { x: 342, y: 153 },
      };
    if (this.columns === 2)
      return {
        sofaX: 58,
        sofaY: 94,
        table: true,
        coffeeX: 500,
        coffeeW: 105,
        printerX: 632,
        printerW: 54,
        lounge: { x: 120, y: 139 },
        coffee: { x: 552, y: 149 },
        printer: { x: 659, y: 153 },
      };
    return {
      sofaX: 58,
      sofaY: 94,
      table: true,
      coffeeX: 760,
      coffeeW: 159,
      printerX: 980,
      printerW: 54,
      lounge: { x: 120, y: 139 },
      coffee: { x: 854, y: 149 },
      printer: { x: 1007, y: 153 },
    };
  }
  lounge(layout) {
    const x = layout.sofaX,
      y = layout.sofaY;
    this.rug(x + 6, y + 12, layout.table ? 211 : 128, 45);
    this.rect(x, y, 121, 31, "#5b7459");
    this.rect(x + 4, y - 3, 113, 23, "#7d9871");
    this.rect(x + 8, y + 16, 48, 21, "#9caf86");
    this.rect(x + 60, y + 16, 48, 21, "#91a681");
    this.rect(x, y + 12, 8, 30, "#647e5d");
    this.rect(x + 113, y + 12, 8, 30, "#647e5d");
    this.rect(x + 6, y + 42, 5, 6, "#687363");
    this.rect(x + 107, y + 42, 5, 6, "#687363");
    // Cushions and a folded blanket keep the lounge recognizable even when nobody leaves a desk.
    this.rect(x + 13, y + 5, 21, 14, "#c0b98e");
    this.rect(x + 15, y + 7, 17, 2, "#d9caa1");
    this.rect(x + 76, y + 25, 26, 12, "#728c91");
    this.rect(x + 76, y + 34, 26, 2, "#a3b8af");
    if (layout.table) {
      const tx = x + 141;
      this.rect(tx + 4, y + 24, 48, 28, "#837d6444");
      this.rect(tx, y + 18, 48, 27, "#bda982");
      this.rect(tx, y + 18, 48, 3, "#e0c99b");
      this.rect(tx + 13, y + 25, 17, 12, "#7f9e9b");
      this.rect(tx + 16, y + 27, 11, 1, "#dbe1c9");
      this.cup(tx + 35, y + 25);
      this.plant(tx + 87, y + 45, 0.75);
    }
  }
  cup(x, y, steam = false) {
    this.rect(x, y, 8, 8, "#eee8cd");
    this.rect(x + 1, y, 5, 2, "#74684d");
    this.rect(x + 7, y + 2, 3, 4, "#eee8cd");
    if (steam) {
      const rise = Math.floor((this.time * 3) % 4);
      this.rect(x + 2, y - 5 - rise, 1, 4, "#eef0dcaa");
      this.rect(x + 5, y - 8 + rise, 1, 3, "#eef0dc88");
    }
  }
  coffee(layout) {
    const x = layout.coffeeX,
      y = 94,
      w = layout.coffeeW,
      mx = x + w - 53;
    this.rect(x + 4, y + 9, w, 47, "#59614e33");
    this.rect(x, y, w, 47, "#9b9f8c");
    this.rect(x + 4, y + 7, w / 2 - 7, 34, "#b8bba4");
    this.rect(x + w / 2 + 2, y + 7, w / 2 - 6, 34, "#b2b59f");
    this.rect(x, y - 6, w, 10, "#d8cdb0");
    this.rect(x + w / 2 - 6, y + 18, 2, 12, "#7b8472");
    this.rect(x + w - 10, y + 18, 2, 12, "#7b8472");
    this.rect(mx, y - 36, 39, 30, "#677a75");
    this.rect(mx + 3, y - 34, 32, 8, "#a6b8b0");
    this.rect(mx + 7, y - 21, 23, 13, "#374e48");
    this.rect(mx + 12, y - 23, 12, 3, "#c7d4b7");
    this.cup(mx + 14, y - 15, true);
    this.rect(mx + 30, y - 30, 3, 2, "#a9c68c");
    const brewing = [...this.visits.values()].some(
      (visit) =>
        visit.resource === "coffee" &&
        this.visitPosition(visit).phase === "staying",
    );
    if (brewing)
      this.rect(
        mx + 18,
        y - 20,
        1,
        4 + (Math.floor(this.time * 6) % 2),
        "#b9976d",
      );
    if (w > 100) {
      this.cup(x + 12, y - 14);
      this.cup(x + 29, y - 14);
      this.rect(x + 14, y - 31, 19, 14, "#c4b08a");
      this.rect(x + 17, y - 27, 13, 2, "#e6d4ad");
    }
  }
  printer(layout) {
    const x = layout.printerX,
      y = 100,
      w = layout.printerW;
    const inUse = [...this.visits.values()].some(
      (visit) =>
        visit.resource === "printer" &&
        this.visitPosition(visit).phase === "staying",
    );
    // Decorative paper feeding has its own local clock; it never changes a task's real state.
    const phase = (this.time + 7) % 19,
      printing = inUse || phase < 3.8,
      feed = printing ? Math.floor((this.time * 8) % 12) : 0;
    this.rect(x + 4, y + 8, w, 43, "#53604c33");
    this.rect(x, y, w, 43, "#87988d");
    this.rect(x + 3, y + 7, w - 6, 33, "#c2cabe");
    this.rect(x + 6, y + 17, w - 12, 3, "#8a9b8d");
    this.rect(x + 6, y + 33, w - 12, 4, "#acb8a8");
    this.rect(x + 6, y + 41, 5, 5, "#65796b");
    this.rect(x + w - 11, y + 41, 5, 5, "#65796b");
    this.rect(x + 4, y - 13, w - 8, 15, "#5f746b");
    this.rect(x + 10, y - 26, w - 21, 19, "#e7ecdc");
    this.rect(x + 13, y - 22, w - 28, 2, "#bac8b6");
    this.rect(x + 13, y - 17, w - 30, 2, "#cad3c0");
    this.rect(x - 2, y - 1, w + 4, 10, "#dde1ce");
    this.rect(x + w - 12, y + 1, 5, 3, printing ? "#9fc584" : "#769b80");
    this.rect(x + 6, y + 21, w - 12, 8, "#52675d");
    this.rect(x + 10, y + 23, w - 20, 6 + feed, "#f2efdb");
    this.rect(x + 13, y + 25, w - 28, 1, "#b3c4b3");
    if (feed > 5) this.rect(x + 13, y + 30, w - 30, 1, "#b3c4b3");
  }
  buildRoute(seat, resource) {
    const goal = this.lobbyLayout()[resource],
      aisleX = seat.room.x + seat.room.w / 2,
      corridorX = seat.room.x - 11;
    const points = [
      { x: seat.x + 63, y: seat.y + 96 },
      { x: seat.x + 63, y: seat.y + 104 },
      { x: aisleX, y: seat.y + 104 },
      { x: aisleX, y: seat.room.y + 78 },
      { x: corridorX, y: seat.room.y + 78 },
      { x: corridorX, y: 171 },
      { x: goal.x, y: 171 },
      { x: goal.x, y: goal.y },
    ];
    const route = points.filter(
      (point, i) =>
        !i || point.x !== points[i - 1].x || point.y !== points[i - 1].y,
    );
    let length = 0;
    for (let i = 1; i < route.length; i++)
      length += Math.hypot(
        route[i].x - route[i - 1].x,
        route[i].y - route[i - 1].y,
      );
    return { route, length };
  }
  updateLife() {
    if (!this.wandering || !this.motion) return;
    for (const [key, visit] of this.visits)
      if (this.time >= visit.end) {
        this.visits.delete(key);
        this.nextDeparture[visit.seat.room.col] =
          this.time + 10 + (visit.seat.seed % 13);
      }
    for (let col = 0; col < this.columns; col++) {
      if (
        [...this.visits.values()].some(
          (visit) => visit.seat.room.col === col,
        ) ||
        this.time < (this.nextDeparture[col] ?? Infinity)
      )
        continue;
      const pool = this.wanderCandidates[col];
      if (!pool?.length) {
        this.nextDeparture[col] = this.time + 5;
        continue;
      }
      const number = this.departureNumber[col] || 0;
      // Prefer nearby, visible people. Long offices keep just one visitor per column, never one per seat.
      const viewTop = this.viewport.scrollTop / this.scale,
        nearby = pool.filter(
          (seat) =>
            seat.y >= viewTop - 180 &&
            seat.y < viewTop + this.viewport.clientHeight / this.scale + 80,
        );
      const choices = nearby.length ? nearby : pool.slice(0, 4),
        seat =
          choices[(number + hash(`${col}:${choices.length}`)) % choices.length];
      const used = new Set(
        [...this.visits.values()].map((visit) => visit.resource),
      );
      let resources =
        seat.task.status === "working"
          ? ["coffee", "printer"]
          : ["lounge", "coffee", "printer"];
      if (seat.task.status === "working" && (seat.seed + number) % 2)
        resources.reverse();
      const resource = resources.find((candidate) => !used.has(candidate));
      if (!resource) {
        this.nextDeparture[col] = this.time + 4;
        continue;
      }
      const { route, length } = this.buildRoute(seat, resource),
        speed = 57 + (seat.seed % 13),
        travel = length / speed,
        dwell =
          resource === "lounge" ? 14 + (seat.seed % 7) : 7 + (seat.seed % 5);
      const kind =
        resource === "lounge"
          ? (seat.seed + number) % 2
            ? "nap"
            : "lounge"
          : resource;
      this.visits.set(seat.key, {
        seat,
        status: seat.task.status,
        resource,
        kind,
        route,
        length,
        speed,
        start: this.time,
        travel,
        dwell,
        end: this.time + travel * 2 + dwell,
      });
      this.departureNumber[col] = number + 1;
    }
  }
  visitPosition(visit) {
    const elapsed = Math.max(0, this.time - visit.start);
    let distance, phase;
    if (elapsed < visit.travel) {
      distance = elapsed * visit.speed;
      phase = "outbound";
    } else if (elapsed < visit.travel + visit.dwell) {
      const goal = visit.route.at(-1);
      return { ...goal, phase: "staying", direction: 0 };
    } else {
      distance = Math.max(
        0,
        visit.length - (elapsed - visit.travel - visit.dwell) * visit.speed,
      );
      phase = "returning";
    }
    for (let i = 1; i < visit.route.length; i++) {
      const a = visit.route[i - 1],
        b = visit.route[i],
        segment = Math.hypot(b.x - a.x, b.y - a.y);
      if (distance <= segment) {
        const amount = distance / segment,
          sign = phase === "returning" ? -1 : 1;
        return {
          x: a.x + (b.x - a.x) * amount,
          y: a.y + (b.y - a.y) * amount,
          phase,
          direction: Math.sign(b.x - a.x) * sign,
          vertical: Math.sign(b.y - a.y) * sign,
        };
      }
      distance -= segment;
    }
    return { ...visit.route.at(-1), phase, direction: 0 };
  }
  head(x, y, seed, { sleep = false, blink = false, look = 1 } = {}) {
    const skin = SKIN[seed % 4],
      hair = HAIR[seed % 4];
    this.rect(x - 11, y + 5, 23, 22, skin);
    this.rect(x - 15, y + 3, 30, 14, hair);
    this.rect(x - 12, y - 2, 24, 7, hair);
    this.rect(x - 14, y + 11, 6, 12, hair);
    this.rect(x - 8, y - 1, 8, 3, "#a39a7633");
    this.rect(
      x + (look < 0 ? -7 : 9),
      y + 15,
      sleep ? 5 : 3,
      sleep || blink ? 1 : 3,
      "#3f4735",
    );
    this.rect(x - 6, y + 24, 11, 3, skin);
  }
  seatedPerson(seat) {
    const { x, y, role, seed, task } = seat,
      skin = SKIN[seed % 4],
      working = task.status === "working";
    const cycle = (this.time + (seed % 29)) % 30;
    const pose = working
      ? cycle < 16
        ? "typing"
        : cycle < 19
          ? "thinking"
          : cycle < 22
            ? "sip"
            : cycle < 25
              ? "stretch"
              : "typing"
      : cycle < 10
        ? "reading"
        : cycle < 20 && ["idle", "done"].includes(task.status)
          ? "sleep"
          : cycle < 24
            ? "stretch"
            : "sip";
    const beat =
        Math.floor(
          this.time / (0.19 + (seed % 6) * 0.035 + (cycle > 25 ? 0.1 : 0)),
        ) % 2,
      bob =
        pose === "sleep" ? 3 : Math.floor((this.time + (seed % 5)) * 1.7) % 2;
    this.rect(x + 49, y + 64, 28, 21, role.color);
    this.rect(x + 47, y + 69, 5, 11, role.color);
    this.rect(x + 75, y + 68, 6, 12, role.color);
    if (pose === "stretch") {
      this.rect(x + 41, y + 58, 8, 14, role.color);
      this.rect(x + 76, y + 53, 8, 19, role.color);
      this.rect(x + 40, y + 51 - bob, 7, 9, skin);
      this.rect(x + 78, y + 46 + bob, 7, 9, skin);
    } else if (pose === "typing") {
      this.rect(x + 75, y + 66 - beat * 2, 6, 12, role.color);
      this.rect(x + 78, y + 61 - beat * 2, 7, 7, skin);
      this.rect(x + 46, y + 63 + beat * 2, 6, 8, skin);
    } else {
      this.rect(x + 46, y + 68, 6, 8, skin);
      this.rect(x + 78, y + 67, 7, 7, skin);
    }
    const headX = x + 63 + (pose === "thinking" ? 2 : 0),
      headY = y + 43 + bob + (pose === "sleep" ? 7 : 0);
    this.head(headX, headY, seed, {
      sleep: pose === "sleep",
      blink: (this.time + (seed % 7)) % 5.6 < 0.2,
    });
    if (pose === "sip") {
      this.rect(x + 76, y + 59, 7, 13, role.color);
      this.rect(x + 74, y + 55, 7, 7, skin);
      this.cup(x + 73, y + 54, true);
    }
    if (pose === "thinking") {
      this.rect(x + 77, y + 62, 6, 10, role.color);
      this.rect(x + 71, y + 62, 8, 6, skin);
    }
    if (pose === "reading") {
      this.rect(x + 50, y + 75, 28, 15, "#f0e9cf");
      this.rect(x + 53, y + 78, 18, 1, "#9baa96");
      this.rect(x + 53, y + 81, 21, 1, "#b1b9a2");
      this.rect(x + 46, y + 75, 7, 6, skin);
    }
    if (pose === "sleep") this.sleepMarks(x + 84, y + 45, seed);
  }
  sleepMarks(x, y, seed) {
    const float = Math.floor((this.time * 1.8 + (seed % 3)) % 4);
    this.text("z", x, y - float, 9, "#657863", "700");
    this.text("z", x + 8, y - 9 - float, 12, "#657863", "600");
  }
  standingPerson(visit, position) {
    const { x, y, phase, direction } = position,
      { seat } = visit,
      skin = SKIN[seat.seed % 4],
      walking = phase !== "staying",
      beat = Math.floor((this.time + (seat.seed % 3)) * 5) % 2,
      bob = walking ? beat : 0;
    const c = this.ctx;
    c.save();
    c.translate(Math.round(x), Math.round(y));
    c.scale(0.7, 0.82);
    this.rect(-12, 0, 25, 5, "#58685733");
    this.rect(-8, -13, 7, 13 + (walking ? beat * 2 : 0), "#526356");
    this.rect(2, -13, 7, 13 + (walking ? (1 - beat) * 2 : 0), "#526356");
    this.rect(-9, -1 + (walking ? beat * 2 : 0), 8, 4, "#394e44");
    this.rect(2, -1 + (walking ? (1 - beat) * 2 : 0), 9, 4, "#394e44");
    this.rect(-10, -30 - bob, 22, 19, seat.role.color);
    this.rect(
      -15,
      -27 - bob,
      6,
      14 - (walking ? beat * 3 : 0),
      seat.role.color,
    );
    this.rect(11, -27 - bob, 6, 12 + (walking ? beat * 3 : 0), seat.role.color);
    this.rect(-15, -15 - (walking ? beat * 3 : 0), 6, 6, skin);
    this.rect(11, -16 + (walking ? beat * 3 : 0), 6, 6, skin);
    this.head(0, -49 - bob, seat.seed, {
      blink: (this.time + (seat.seed % 7)) % 5.6 < 0.2,
      look: direction || 1,
    });
    if (phase === "staying" && visit.resource === "coffee") {
      this.rect(9, -27, 6, 11, seat.role.color);
      this.rect(8, -31, 7, 7, skin);
      this.cup(9, -33, true);
    }
    if (phase === "staying" && visit.resource === "printer") {
      this.rect(-10, -25, 22, 15, "#f0ecda");
      this.rect(-7, -22, 15, 1, "#9cae9b");
      this.rect(-7, -18, 12, 1, "#b4c1aa");
      this.rect(-14, -24, 6, 6, skin);
      this.rect(10, -22, 6, 6, skin);
    }
    if (phase === "returning" && visit.resource === "coffee") this.cup(12, -17);
    if (phase === "returning" && visit.resource === "printer") {
      this.rect(-18, -21, 10, 14, "#eee9d4");
      this.rect(-16, -18, 6, 1, "#a0af9b");
    }
    c.restore();
  }
  restingPerson(visit, position) {
    const { x, y } = position,
      { seat } = visit,
      skin = SKIN[seat.seed % 4];
    if (visit.kind === "nap") {
      this.rect(x - 37, y - 22, 30, 13, "#526356");
      this.rect(x - 38, y - 19, 7, 9, "#3d5347");
      this.rect(x - 14, y - 24, 35, 18, seat.role.color);
      this.rect(x - 10, y - 12, 19, 6, skin);
      this.head(x + 28, y - 31, seat.seed, { sleep: true });
      this.rect(x - 26, y - 9, 41, 7, "#7e9991");
      this.sleepMarks(x + 50, y - 26, seat.seed);
    } else {
      this.rect(x - 13, y - 7, 12, 12, "#526356");
      this.rect(x + 4, y - 7, 12, 12, "#526356");
      this.rect(x - 13, y - 27, 29, 23, seat.role.color);
      this.rect(x - 17, y - 21, 7, 15, skin);
      this.rect(x + 15, y - 23, 7, 13, skin);
      this.head(x + 1, y - 47, seat.seed, {
        blink: (this.time + (seat.seed % 7)) % 5.6 < 0.2,
      });
      this.cup(x + 15, y - 17, true);
    }
  }
  desk(seat) {
    const { x, y, task, role, seed } = seat,
      active = task.status === "working",
      away = this.visits.has(seat.key);
    this.rect(x + 11, y + 27, 119, 50, "#77846a22");
    this.rect(x + 11, y + 63, 8, 20, "#8b917a");
    this.rect(x + 115, y + 63, 8, 20, "#8b917a");
    this.rect(x + 7, y + 19, 118, 50, "#9b987b");
    this.rect(x + 7, y + 15, 118, 48, "#d7bb85");
    this.rect(x + 8, y + 16, 116, 3, "#eed6a2");
    this.rect(x + 9, y + 58, 112, 4, "#b39b6f");
    this.rect(x + 19, y + 38, 32, 1, "#c3ac7d");
    this.rect(x + 89, y + 28, 25, 1, "#c3ac7d");
    this.rect(x + 46, y + 5, 49, 33, "#9b9c82");
    this.rect(x + 44, y + 1, 49, 33, "#4b5e57");
    this.rect(x + 47, y + 4, 43, 25, "#273e3b");
    this.rect(x + 48, y + 5, 41, 23, active ? "#314e4e" : "#779493");
    this.rect(x + 65, y + 33, 7, 5, "#627468");
    this.rect(x + 58, y + 37, 24, 3, "#718170");
    if (active) {
      for (let i = 0; i < 4; i++) {
        this.rect(
          x + 51,
          y + 9 + i * 4,
          11 + ((seed + i * 9) % 20),
          1,
          ["#8baaa2", "#b4c9a5", "#b09b7f", "#7b9b9a"][i],
        );
      }
      this.rect(x + 53 + (this.frame % 3) * 4, y + 24, 2, 2, "#ebd7a2");
    } else {
      this.rect(x + 55, y + 10, 25, 3, "#cedccb");
      this.rect(x + 55, y + 17, 17, 2, "#b3c8bb");
    }
    this.rect(x + 47, y + 44, 42, 12, "#6d8072");
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 8; b++)
        this.rect(x + 49 + b * 4, y + 46 + a * 3, 2, 1, "#b2bca3");
    this.rect(x + 99, y + 44, 6, 10, "#bbc6ac");
    this.rect(x + 18, y + 22, 12, 15, "#799792");
    this.rect(x + 19, y + 22, 9, 2, "#afbbA0");
    this.rect(x + 107, y + 21, 8, 8, "#eee8cd");
    this.rect(x + 108, y + 21, 5, 3, "#68776b");
    this.rect(x + 114, y + 23, 3, 4, "#eee8cd");
    // The original chair, monitor, task bubble, and real status stay at the assigned desk.
    this.rect(x + 41, y + 62, 42, 33, "#3f544b");
    this.rect(x + 37, y + 77, 8, 12, "#566b5c");
    this.rect(x + 80, y + 77, 8, 12, "#566b5c");
    this.rect(x + 51, y + 94, 3, 7, "#566b5c");
    this.rect(x + 73, y + 94, 3, 7, "#566b5c");
    this.rect(x + 47, y + 70, 28, 24, "#75826a");
    if (!away) this.seatedPerson(seat);
    else {
      this.rect(x + 52, y + 76, 20, 5, role.color);
      this.rect(x + 96, y + 70, 13, 11, "#ebe7cc");
      this.rect(x + 99, y + 75, 7, 2, role.color);
      this.rect(x + 103, y + 72, 3, 6, role.color);
    }
    const color = STATUS_COLORS[task.status] || STATUS_COLORS.unknown;
    this.rect(x + 99, y + 1, 22, 18, "#fff9de");
    this.rect(x + 99, y + 17, 4, 5, "#fff9de");
    this.rect(x + 100, y + 2, 20, 15, color);
    if (task.status === "working") {
      for (let dot = 0; dot < 3; dot++)
        this.rect(x + 103 + dot * 5, y + 8, 3, 3, "#04111a");
    } else if (task.status === "done") {
      this.rect(x + 104, y + 8, 3, 3, "#04111a");
      this.rect(x + 107, y + 11, 3, 3, "#04111a");
      this.rect(x + 110, y + 8, 3, 3, "#04111a");
      this.rect(x + 113, y + 5, 3, 3, "#04111a");
    } else
      this.text(
        { waiting: "!", error: "!", unknown: "?", idle: "–" }[task.status] ||
          "?",
        x + 106,
        y + 14,
        14,
        "#04111a",
        "700",
      );
    if (task.source === "work") {
      this.rect(x + 14, y + 47, 12, 7, "#dde5d3");
      this.rect(x + 16, y + 44, 6, 5, "#dde5d3");
    }
  }
  draw() {
    const c = this.ctx;
    if (!this.roles) return;
    this.updateLife();
    const top = Math.floor(this.viewport.scrollTop / this.scale),
      height = Math.min(
        this.height,
        Math.ceil(this.viewport.clientHeight / this.scale) + 4,
      );
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.height = `${height * this.scale}px`;
    this.canvas.style.top = `${top * this.scale}px`;
    c.setTransform(1, 0, 0, 1, 0, -top);
    c.imageSmoothingEnabled = false;
    this.rect(0, top, this.width, height, "#ced4c5");
    for (
      let y = Math.floor(top / 24) * 24;
      y < Math.min(this.height, top + height);
      y += 24
    )
      for (let x = 0; x < this.width; x += 24) {
        this.rect(x, y, 24, 24, (x / 24 + y / 24) % 2 ? "#d4d8c9" : "#d0d5c5");
        this.rect(x, y, 24, 1, "#c6cebd55");
      }
    this.rect(10, 12, this.width - 20, this.height - 27, "#687c6522");
    this.rect(8, 7, this.width - 20, 78, "#aab09a");
    this.rect(12, 8, this.width - 28, 65, "#e5e5ce");
    this.rect(12, 72, this.width - 28, 9, "#b6bea7");
    this.rect(8, 5, this.width - 20, 4, "#687868");
    this.officeFrame(top, height);
    if (top < 180) {
      const layout = this.lobbyLayout();
      this.window(43, 18, this.columns === 1 ? 158 : 232);
      if (this.columns === 1) this.window(222, 18, 133);
      else this.window(389, 18, 219);
      if (this.columns > 2) this.window(740, 18, 219);
      this.lounge(layout);
      this.coffee(layout);
      this.printer(layout);
      if (this.columns === 1) this.plant(185, 132, 0.58);
      else {
        this.plant(325, 77, 0.7);
        this.plant(this.width - 45, 134, 0.75);
      }
      if (this.columns > 2) {
        this.woodSign(366, 91, 302);
        this.plant(704, 134, 0.65);
      } else if (this.columns === 2) {
        this.woodSign(319, 105, 170, true);
      } else {
        this.rect(this.width / 2 - 59, 10, 118, 21, "#806846");
        this.rect(this.width / 2 - 57, 12, 114, 17, "#ddbf8a");
        c.save();
        c.textAlign = "center";
        this.text("WORKROOM", this.width / 2, 25, 14, "#1c3b51", "750");
        c.restore();
      }
    }
    for (const room of this.rooms) {
      const { x, y, w, h, role, jobs } = room;
      if (y > top + height || y + h < top) continue;
      this.rect(x + 4, y + 5, w, h, "#82937433");
      this.rect(x, y, w, h, "#486271");
      this.rect(x + 1, y + 1, w - 2, h - 2, "#98a58f");
      this.rect(x + 3, y + 3, w - 6, h - 6, "#e0dfc5");
      this.rect(x + 6, y + 37, w - 12, h - 43, "#e5e2cb");
      for (
        let py = Math.max(
          y + 40,
          y + 40 + Math.floor((top - y - 40) / 18) * 18,
        );
        py < Math.min(y + h - 8, top + height);
        py += 18
      ) {
        this.rect(x + 6, py, w - 12, 1, "#d4d4b866");
        for (let px = x + 8 + (py % 36 ? 0 : 45); px < x + w - 8; px += 90)
          this.rect(px, py, 1, 18, "#d4d4b866");
      }
      const headerColor = blendHex(role.color, "#f5f8fa", 0.18),
        headerInk = blendHex(role.color, "#153047", 0.25);
      c.fillStyle = headerColor;
      c.fillRect(x + 3, y + 3, w - 6, 31);
      this.rect(x + 4, y + 3, w - 8, 2, "#f4f7f8");
      this.rect(x + 10, y + 8, 20, 21, headerInk);
      this.rect(x + 12, y + 10, 16, 16, role.color);
      this.rect(x + 16, y + 14, 8, 2, "#162f43");
      this.rect(x + 16, y + 19, 8, 2, "#162f43");
      c.save();
      c.beginPath();
      c.rect(
        x + 37,
        y + 3,
        w - 82 - Math.max(25, String(jobs.length).length * 9),
        30,
      );
      c.clip();
      this.text(roleName(role), x + 37, y + 26, 17, headerInk, "700");
      c.restore();
      c.save();
      c.textAlign = "right";
      this.text(`${jobs.length}`, x + w - 35, y + 26, 15, headerInk, "650");
      c.restore();
      this.rect(x + w - 23, y + 11, 6, 6, headerInk);
      this.rect(x + w - 26, y + 19, 12, 6, headerInk);
      this.rect(x + 3, y + 33, w - 6, 3, blendHex(role.color, "#96b0bc", 0.26));
      if (!jobs.length) {
        this.emptyRoom(room);
      } else {
        this.plant(x + w - 19, y + h - 23, 0.47);
        this.plant(x + 17, y + h - 29, 0.38);
        if (jobs.length % 2) {
          const spareY = y + 84 + Math.floor(jobs.length / 2) * 146;
          this.wallBoard(
            x + 218,
            spareY - 24,
            63,
            47,
            role.id === "design" ? "design" : "notes",
          );
          this.shelf(x + 211, spareY + 31, 67);
        }
      }
      // Open door to the shared corridor.
      this.rect(x + w / 2 - 24, y + h - 5, 49, 8, "#d4d8c9");
      this.rect(x + w / 2 - 22, y + h - 7, 45, 2, "#abae90");
      if (jobs.length) {
        this.rect(x - 2, y + 55, 10, 33, "#d4d8c9");
        this.rect(x + 3, y + 55, 4, 3, "#aab09a");
        this.rect(x + 3, y + 85, 4, 3, "#aab09a");
      }
    }
    for (const seat of this.seats)
      if (seat.y + seat.h >= top && seat.y <= top + height) this.desk(seat);
    // An away avatar has exactly one location; its home task button is never moved or hidden.
    const visitors = [...this.visits.values()]
      .map((visit) => ({ visit, position: this.visitPosition(visit) }))
      .sort((a, b) => a.position.y - b.position.y);
    for (const { visit, position } of visitors)
      if (position.y + 10 >= top && position.y - 55 <= top + height) {
        if (position.phase === "staying" && visit.resource === "lounge")
          this.restingPerson(visit, position);
        else this.standingPerson(visit, position);
      }
    const bottom = this.height - 28;
    this.rect(25, bottom + 18, this.width - 50, 2, "#aab09a");
    c.save();
    c.textAlign = "center";
    this.text(
      "WELCOME TO YOUR OFFICE",
      this.width / 2,
      bottom + 13,
      14,
      this.dark ? "#e3e9f0" : "#253e57",
      "600",
    );
    c.restore();
    this.plant(48, bottom + 10, 0.5);
    this.plant(this.width - 48, bottom + 10, 0.5);
  }
  destroy() {
    clearInterval(this.timer);
    this.resize.disconnect();
    this.viewport.removeEventListener("scroll", this.onScroll);
    this.visits.clear();
  }
}
