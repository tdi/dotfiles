// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.
//
// my-spaces additions: spaces are grouped by company, from the GitHub org in the
// repo's origin (COMPANIES below; anything else is Private), and the real space order
// follows the groups so ctrl+1..9 match what's shown. A worktree space whose branch's
// PR is merged (gh) shows "merged · remove", which opens the worktree remove dialog.
// Running dev stacks (docker compose projects, by their working dir, and portal's Tilt
// slots) show as a chip on their space's row; click for a menu that stops them. Stacks
// whose folder has no space are listed at the bottom, so none keeps running forgotten.
// New worktrees get their setup steps from ~/.config/herdr-app/worktree-setup.toml
// (copy .env, mise trust, ...), run once, quietly, with a notification when done.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, notify, appHome, readTextFile, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const COMPANIES = [
  { name: "Bitropy", match: /github\.com[:/]bitropy\//i, color: "ansi4" },
  { name: "Whenubuy", match: /github\.com[:/]whenubuy\/|gitlab\.com[:/]com\.whenubuy\//i, color: "ansi3" },
];
const PRIVATE = { name: "Private", color: "ansi5" };
const companyOf = (url) => COMPANIES.find((c) => c.match.test(url ?? "")) ?? PRIVATE;
const companyRank = (name) => { const i = COMPANIES.findIndex((c) => c.name === name); return i < 0 ? COMPANIES.length : i; };
const MERGED_EVERY = 5 * 60000;

// ---------- dev stacks ----------
const DEV_EVERY = 30000;
const TILT_PORTS = Array.from({ length: 10 }, (_, i) => 10350 + i);
// Tilt's /api/view is over 1 MB (logs): cut down to [name, runtime, update] on the machine.
const SLIM = `slim() { if command -v jq >/dev/null 2>&1; then jq -c '[.uiResources[]? | [.metadata.name, .status.runtimeStatus, .status.updateStatus]]' 2>/dev/null; else python3 -c 'import json,sys
try: print(json.dumps([[r["metadata"]["name"], r.get("status",{}).get("runtimeStatus"), r.get("status",{}).get("updateStatus")] for r in json.load(sys.stdin).get("uiResources",[])]))
except Exception: pass'; fi; }`;
const DEV_PROBE = [
  SLIM,
  `printf "@@docker\\n"; docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Names}}|{{.RunningFor}}' 2>/dev/null`,
  'printf "@@slots\\n"; cat "$HOME/.cache/portal-tilt/slots" 2>/dev/null',
  ...TILT_PORTS.map((p) => `printf "@@tilt ${p}\\n"; curl -s -m 2 http://127.0.0.1:${p}/api/view 2>/dev/null | slim; echo`),
].join("; ");

// { stacks: [{ project, dir, names, since }], tilts: [{ port, slot, dir, errors, pending, total }] }
function parseDev(out) {
  const parts = {};
  for (const chunk of out.split(/^@@/m).slice(1)) {
    const nl = chunk.indexOf("\n");
    parts[chunk.slice(0, nl)] = chunk.slice(nl + 1).trim();
  }
  const byProject = new Map();
  for (const line of (parts.docker || "").split("\n")) {
    const [project, dir, name, since] = line.split("|");
    if (!project || !dir) continue;
    const s = byProject.get(project) ?? { project, dir, names: [], since };
    s.names.push(name);
    byProject.set(project, s);
  }
  const slots = {};
  for (const l of (parts.slots || "").split("\n")) { const m = /^(\d)\s+(.+)$/.exec(l.trim()); if (m) slots[m[1]] = m[2]; }
  const tilts = [];
  for (const port of TILT_PORTS) {
    try {
      const rs = JSON.parse(parts[`tilt ${port}`] || "null");
      if (!Array.isArray(rs) || !rs.length) continue;
      const busy = (v) => v === "pending" || v === "in_progress";
      const slot = String(port - 10350);
      tilts.push({ port, slot, dir: slots[slot] ?? null,
        errors: rs.filter(([, r, u]) => r === "error" || u === "error").map(([n]) => n),
        pending: rs.filter(([, r, u]) => busy(r) || busy(u)).length, total: rs.length });
    } catch {}
  }
  return { stacks: [...byProject.values()], tilts };
}
// ---------- worktree setup ----------
const SETUP_FRESH_S = 600; // a worktree is new for 10 minutes after `git worktree add`
// The few TOML shapes worktree-setup.toml uses: [default] / [[project]] with path and steps.
function parseSetup(text) {
  const conf = { def: null, projects: [] };
  let cur = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+/, "");
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[[project]]")) { cur = { path: null, steps: [] }; conf.projects.push(cur); continue; }
    if (line.startsWith("[default]")) { cur = { steps: [] }; conf.def = cur; continue; }
    const m = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (!m || !cur) continue;
    let value = m[2];
    if (value.startsWith("[")) while (!/\]\s*(#.*)?$/.test(value) && i + 1 < lines.length) value += "\n" + lines[++i];
    const strings = [...value.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1] ?? x[2].replace(/\\(.)/g, "$1"));
    if (m[1] === "steps") cur.steps = strings;
    else if (m[1] === "path") cur.path = strings[0] ?? null;
  }
  return conf;
}
async function setupConfig() {
  const text = await readTextFile(`${appHome()}/worktree-setup.toml`).catch(() => null);
  return text ? parseSetup(text) : null;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.dev = {}; // machine ("" = here) -> parseDev()
    if (props()?.devMenu) { this.confirm = null; this.probeDev([props().devMenu.on], cx); return; }
    cx.timer.after(1500, (cx) => this.probeDev(null, cx));
    cx.timer.every(DEV_EVERY, (cx) => this.probeDev(null, cx));
    this.merged = {}; this.mergedAt = {};
    try { this.foldedCo = new Set(JSON.parse(localStorage.getItem("companies.folded") ?? "[]")); } catch { this.foldedCo = new Set(); }
    cx.timer.every(5000, (cx) => this.checkMerged(cx));
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const origin = await exec("git", ["config", "--get", "remote.origin.url"], { cwd, on }).catch(() => null);
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { top, name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git`,
        origin: origin?.code === 0 ? origin.stdout.trim() : "", company: companyOf(origin?.code === 0 ? origin.stdout.trim() : "").name };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
      if (info.linked) this.maybeSetup(key, info, on, repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const blocks = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      const company = r.g?.company ?? PRIVATE.name;
      const block = [{ ...r, tree: null, company }];
      blocks.push(block);
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => block.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─", company }));
    }
    // Company groups in COMPANIES order (stable within each); the real order follows.
    const out = blocks.map((b, n) => ({ b, n }))
      .sort((x, y) => companyRank(x.b[0].company) - companyRank(y.b[0].company) || x.n - y.n)
      .flatMap((x) => x.b);
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    this.lastRows = rows;
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      const { items, activeAt } = this.withCompanies(rows, draw, t, collapsed, "local");
      this.activeAt = activeAt;
      return items;
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const co = this.withCompanies(mine, draw, t, collapsed, m ?? "local");
      const items = [cell(head), ...guidance, ...(folded ? [] : mine.length ? co.items : [loading(m) ? loadingRow(m) : cell(empty)])];
      const first = folded ? -1 : co.activeAt;
      if (first >= 0) this.activeAt = before + 1 + guidance.length + first;
      before += items.length;
      return items;
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one. When the row is full, it
  // and the name both start from their text's width and give way in proportion.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(where ? SIDE_MIN : 0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // Rows with a header before each company (only when there's more than one); a folded
  // company hides its rows. Returns the items and where the active space's row is.
  withCompanies(rows, draw, t, collapsed, scope) {
    const names = [...new Set(rows.map((r) => r.company))];
    if (collapsed || names.length < 2) return { items: rows.map(draw), activeAt: rows.findIndex((r) => r.w.active) };
    const items = [];
    let activeAt = -1;
    for (const name of names) {
      const mine = rows.filter((r) => r.company === name);
      const key = `${scope}:${name}`;
      const folded = this.foldedCo.has(key);
      const c = COMPANIES.find((k) => k.name === name) ?? PRIVATE;
      const busy = mine.filter((r) => r.w.status === "blocked" || r.w.status === "done").length;
      items.push(h_flex().id(`co-${key}`).h(24).mt(items.length ? 6 : 0).px(8).gap(7).flex_none().items_center().rounded(6)
        .text_size(10.5).font_medium().text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.foldedCo.delete(key) : this.foldedCo.add(key);
          localStorage.setItem("companies.folded", JSON.stringify([...this.foldedCo]));
          cx.notify();
        })
        .child(div().size(7).rounded(4).flex_none().bg(t[c.color]))
        .child(div().flex_1().child(name.toUpperCase()))
        .when(folded && busy > 0, (el) => el.child(div().text_color(t.blocked).child(`${busy} need you`)))
        .child(div().child(String(mine.length)))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      if (folded) continue;
      for (const r of mine) {
        if (r.w.active) activeAt = items.length;
        items.push(draw(r));
      }
    }
    return { items, activeAt };
  }

  // Worktree spaces: ask gh (GitHub) or glab (GitLab) whether their branch's PR/MR is
  // merged, each at most every 5 minutes.
  checkMerged(cx) {
    if (this.mergeBusy) return;
    const ps = panes(), now = Date.now();
    const due = spaces().map((w) => [w, where(w, ps)]).filter(([, k]) => {
      const g = this.git[k];
      return g?.linked && g.branch && g.branch !== "(detached)" && now - (this.mergedAt[k] ?? 0) > MERGED_EVERY;
    });
    if (!due.length) return;
    this.mergeBusy = true;
    cx.spawn(async (cx) => {
      for (const [, k] of due) {
        const [on, cwd] = JSON.parse(k);
        const { branch, origin } = this.git[k] ?? {};
        this.mergedAt[k] = Date.now();
        try {
          if (/gitlab/i.test(origin ?? "")) {
            const r = await exec("glab", ["mr", "list", "--source-branch", branch, "--merged", "-F", "json"], { cwd, on, timeout: 20000 });
            const mr = r.code === 0 ? JSON.parse(r.stdout)[0] : null;
            this.merged[k] = mr ? { number: mr.iid, url: mr.web_url, branch, kind: "MR !" } : null;
          } else {
            const r = await exec("gh", ["pr", "view", branch, "--json", "state,number,url"], { cwd, on, timeout: 20000 });
            const pr = r.code === 0 ? JSON.parse(r.stdout) : null;
            this.merged[k] = pr?.state === "MERGED" ? { number: pr.number, url: pr.url, branch, kind: "PR #" } : null;
          }
        } catch { /* gh/glab missing or the machine away: try again later */ }
      }
      this.mergeBusy = false;
      cx.notify();
    });
  }

  // A worktree made in the last 10 minutes without the done-marker: run its setup steps.
  maybeSetup(key, info, on, repo, cx) {
    this.setupTried ??= new Set();
    if (this.setupTried.has(info.top)) return;
    this.setupTried.add(info.top);
    cx.spawn(async (cx) => {
      const opts = { cwd: info.top, ...(on ? { on } : {}) };
      const probe = await exec("sh", ["-c", 'd=$(git rev-parse --absolute-git-dir) || exit 1; [ -e "$d/herdr-setup-done" ] && { echo done; exit 0; }; b=$(stat -f %B "$d" 2>/dev/null || stat -c %W "$d"); echo "$d $(( $(date +%s) - b ))"'], opts).catch(() => null);
      const out = probe?.code === 0 ? probe.stdout.trim() : "done";
      const [gitDir, age] = out.split(" ");
      if (out === "done" || !(Number(age) >= 0 && Number(age) < SETUP_FRESH_S)) return;
      const conf = await setupConfig();
      if (!conf) return;
      const main = repo.endsWith("/.git") ? repo.slice(0, -5) : repo;
      const home = (await exec("sh", ["-c", 'printf %s "$HOME"'], on ? { on } : {}).catch(() => null))?.stdout ?? "";
      const norm = (p) => (p ?? "").replace(/^~(?=\/|$)/, home).replace(/\/+$/, "");
      const steps = (conf.projects.find((p) => norm(p.path) === main) ?? conf.def)?.steps ?? [];
      if (!steps.length) return;
      const env = `export HERDR_MAIN_REPO=${shq(main)} HERDR_WORKTREE=${shq(info.top)} HERDR_BRANCH=${shq(info.branch)}`;
      const script = `${env}; set -e; ${steps.join("\n")}\ntouch ${shq(gitDir + "/herdr-setup-done")}`;
      const name = base(info.top);
      const r = await exec("sh", ["-lc", script], { ...opts, timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      notify(r.code === 0
        ? { title: "Worktree set up", body: `${name}: ${steps.length} step${steps.length > 1 ? "s" : ""} done`, level: "info" }
        : { title: "Worktree setup failed", body: `${name}: ${`${r.stderr || r.stdout || ""}`.trim().split("\n").slice(-3).join("\n")}`, level: "error" });
    });
  }

  // Dev stacks on each machine with spaces (or just `only`), every 30 s.
  probeDev(only, cx) {
    if (this.devBusy) return;
    const list = only ?? [...new Set([null, ...spaces().map((s) => s.machine ?? null)])];
    this.devBusy = true;
    cx.spawn(async (cx) => {
      for (const on of list) {
        try {
          const r = await exec("sh", ["-lc", DEV_PROBE], { ...(on ? { on } : {}), timeout: 30000 });
          this.dev[on ?? ""] = parseDev(r.stdout ?? "");
        } catch { /* the machine is away: keep what it showed */ }
      }
      this.devBusy = false;
      cx.notify();
    });
  }

  devAt(on, dir) {
    const d = this.dev[on ?? ""];
    if (!d || !dir) return { stacks: [], tilts: [] };
    return { stacks: d.stacks.filter((s) => s.dir === dir), tilts: d.tilts.filter((x) => x.dir === dir) };
  }

  openDevMenu(on, dir, name) {
    openOverlay({ mod: "my-spaces", kind: "popup", width: 340, height: 260, props: { devMenu: { on, dir, name } } });
  }

  devChip(w, g, t) {
    const { stacks, tilts } = this.devAt(w.machine, g?.top);
    if (!stacks.length && !tilts.length) return null;
    const bad = tilts.some((x) => x.errors.length);
    const tip = [...tilts.map((x) => `Tilt slot ${x.slot}${x.errors.length ? `: ${x.errors.length} error` : ": ok"}`),
      ...stacks.map((s) => `docker ${s.project} (${s.names.length}) · up ${s.since}`), "Click to stop"].join("\n");
    return div().id(`dev-${w.id}`).flex_none().px(5).h(18).flex().items_center().gap(4).rounded(4)
      .text_size(10.5).text_color(bad ? t.blocked : t.ansi2).border_1().border_color(bad ? t.blocked : t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.openDevMenu(w.machine ?? null, g.top, w.name); })
      .child(div().size(6).rounded(3).bg(bad ? t.blocked : t.ansi2))
      .child(tilts.length ? "tilt" : "docker");
  }

  // Stacks whose folder has no space shown: listed under the spaces.
  orphans(rows, t) {
    const tops = new Set(rows.map((r) => `${r.w.machine ?? ""}|${r.g?.top}`));
    const out = [];
    for (const [on, d] of Object.entries(this.dev)) {
      const dirs = new Map();
      for (const s of d.stacks) if (!tops.has(`${on}|${s.dir}`)) (dirs.get(s.dir) ?? dirs.set(s.dir, []).get(s.dir)).push(`docker ${s.project} · up ${s.since}`);
      for (const x of d.tilts) if (x.dir && !tops.has(`${on}|${x.dir}`)) (dirs.get(x.dir) ?? dirs.set(x.dir, []).get(x.dir)).unshift(`Tilt slot ${x.slot}`);
      for (const [dir, what] of dirs) out.push({ on: on || null, dir, what });
    }
    if (!out.length) return [];
    return [
      h_flex().id("orphans-head").h(24).mt(8).px(8).gap(7).flex_none().items_center().text_size(10.5).font_medium().text_color(t.dim)
        .child(div().size(7).rounded(4).flex_none().bg(t.working)).child(div().flex_1().child("RUNNING WITHOUT A SPACE")).child(String(out.length)),
      ...out.map((o) => h_flex().id(`orphan-${o.on ?? ""}-${o.dir}`).h(26).px(8).gap(7).flex_none().items_center().rounded(7)
        .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${o.dir}${o.on ? ` on ${o.on}` : ""}\n${o.what.join("\n")}\nClick to stop`)
        .on_click(() => this.openDevMenu(o.on, o.dir, base(o.dir)))
        .child(div().flex_1().min_w(0).truncate().child(base(o.dir)))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(o.what.length > 1 ? `${o.what.length} running` : o.what[0].split(" · ")[0]))),
    ];
  }

  // The popup copy: what runs in one folder, each with its stop button (click twice).
  devMenu(t) {
    const { on, dir, name } = props().devMenu;
    const { stacks, tilts } = this.devAt(on, dir);
    const act = (id, label, cmd, done) => {
      const armed = this.confirm === id;
      return div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(5).text_size(11).cursor_pointer()
        .bg(armed ? t.blocked : t.raised).text_color(armed ? t.background : t.foreground).border_1().border_color(armed ? t.blocked : t.border)
        .on_click((_e, cx) => {
          if (!armed) { this.confirm = id; cx.notify(); return; }
          this.confirm = null; this.running = label; cx.notify();
          cx.spawn(async (cx) => {
            // The folder may be gone (a removed worktree): run from home then.
            const script = `cd ${shq(dir)} 2>/dev/null || cd "$HOME"; ${cmd}`;
            const r = await exec("sh", ["-lc", script], { ...(on ? { on } : {}), timeout: 180000 }).catch((e) => ({ code: 1, stderr: String(e) }));
            const tail = `${r.stderr || r.stdout || ""}`.trim().split("\n").slice(-3).join("\n");
            notify({ title: r.code === 0 ? done : `${label} failed`, body: r.code === 0 ? name : tail, level: r.code === 0 ? "info" : "error" });
            this.running = null;
            this.probeDev([on], cx);
          });
        })
        .child(armed ? `Confirm ${label.toLowerCase()}` : label);
    };
    const row = (id, title, detail, color, actions) => h_flex().id(id).gap(8).items_center().py(4)
      .child(div().size(7).rounded(4).flex_none().bg(color))
      .child(v_flex().flex_1().min_w(0).child(div().truncate().child(title)).child(div().text_size(10.5).text_color(t.dim).truncate().child(detail)))
      .children(actions);
    return v_flex().size_full().p(12).gap(6).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(div().font_semibold().truncate().child(name))
      .child(div().text_size(10.5).text_color(t.dim).truncate().child(`${dir}${on ? ` · on ${on}` : ""}`))
      .children(tilts.map((x) => row(`tilt-${x.port}`, `Tilt slot ${x.slot}`, x.errors.length ? `errors: ${x.errors.join(", ")}` : `${x.total} resources ok`, x.errors.length ? t.blocked : t.ansi2, [
        ...(on ? [] : [div().id(`ui-${x.port}`).px(8).h(22).flex().items_center().rounded(5).text_size(11).cursor_pointer().bg(t.raised).border_1().border_color(t.border)
          .on_click(() => exec("open", [`http://localhost:${x.port}`])).child("Open")]),
        // Stops the `tilt up` process on that port, then tears its resources down.
        act(`stop-${x.port}`, "Stop", `pid=$(lsof -ti tcp:${x.port} -sTCP:LISTEN); [ -n "$pid" ] && kill $pid; sleep 1; if [ -f Tiltfile ]; then if command -v mise >/dev/null 2>&1; then TILT_PORT=${x.port} mise exec -- tilt down; else TILT_PORT=${x.port} tilt down; fi; fi`, "Tilt stopped"),
      ])))
      .children(stacks.map((s) => row(`stack-${s.project}`, `docker ${s.project}`, `${s.names.join(", ")} · up ${s.since}`, t.ansi4, [
        // `docker compose` (plugin) or the standalone `docker-compose`; with only the project
        // name, no compose file is needed.
        act(`down-${s.project}`, "Down", `if docker compose version >/dev/null 2>&1; then docker compose -p ${shq(s.project)} down; else docker-compose -p ${shq(s.project)} down; fi`, "Docker stack down"),
      ])))
      .when(!stacks.length && !tilts.length, (el) => el.child(div().text_color(t.dim).child(this.dev[on ?? ""] ? "Nothing running here anymore." : "Looking…")))
      .when(Boolean(this.running), (el) => el.child(div().text_size(11).text_color(t.working).child(`${this.running}…`)))
      .child(div().text_size(10.5).text_color(t.dim).child("Click a button twice: once to arm, once to run. Docker volumes are kept."));
  }

  mergedChip(w, t) {
    const k = where(w, panes()), m = this.merged[k];
    if (!m || this.git[k]?.branch !== m.branch) return null;
    return div().id(`merged-${w.id}`).flex_none().px(5).h(18).flex().items_center().rounded(4)
      .text_size(10.5).text_color(t.done).border_1().border_color(t.done).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(`${m.kind}${m.number} is merged. Click to remove this worktree and its space.`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: w.id, action: "remove" } });
      })
      .child("merged · remove");
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(t.foreground).child(w.name))
          .child(this.mergedChip(w, t) ?? (g ? this.gitTail(g, tree, w.name, t) : div().flex_1()))
          .when(Boolean(this.devChip(w, g, t)), (el) => el.child(this.devChip(w, g, t))),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    if (props()?.devMenu) return this.devMenu(t);
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    if (!collapsed) list.push(...this.orphans(this.lastRows ?? [], t));
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(list));
  }
}
