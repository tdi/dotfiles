// Status bar, plus on the right: Docker (Colima) and each running Tilt instance
// (portal's slots 0-9 on ports 10350-10359), both on the machine of the space you're in.
// Tilt shows its worktree (from ~/.cache/portal-tilt/slots) and errors; click opens its UI.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec } from "herdr";

const EVERY = 15000;
const PORTS = Array.from({ length: 10 }, (_, i) => 10350 + i);

// One shell round trip for everything: colima's JSON, the slots file, then each Tilt
// port's resources. Tilt's /api/view is over 1 MB (logs), so it's cut down to
// [name, runtimeStatus, updateStatus] on the machine itself (jq, else python3).
const SLIM = `slim() { if command -v jq >/dev/null 2>&1; then jq -c '[.uiResources[]? | [.metadata.name, .status.runtimeStatus, .status.updateStatus]]' 2>/dev/null; else python3 -c 'import json,sys
try: print(json.dumps([[r["metadata"]["name"], r.get("status",{}).get("runtimeStatus"), r.get("status",{}).get("updateStatus")] for r in json.load(sys.stdin).get("uiResources",[])]))
except Exception: pass'; fi; }`;
const PROBE = [
  SLIM,
  'printf "@@colima\\n"; (colima list -j 2>/dev/null || echo "{}")',
  'printf "@@slots\\n"; cat "$HOME/.cache/portal-tilt/slots" 2>/dev/null',
  ...PORTS.map((p) => `printf "@@tilt ${p}\\n"; curl -s -m 2 http://127.0.0.1:${p}/api/view 2>/dev/null | slim; echo`),
].join("; ");

function parse(out) {
  const parts = {};
  for (const chunk of out.split(/^@@/m).slice(1)) {
    const nl = chunk.indexOf("\n");
    parts[chunk.slice(0, nl)] = chunk.slice(nl + 1).trim();
  }
  let docker = null;
  try {
    const lines = (parts.colima || "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const c = lines.find((l) => l.name === "default") ?? lines[0];
    if (c?.status) docker = { running: c.status === "Running", detail: `${c.name} · ${c.cpus ?? "?"} CPU · ${Math.round((c.memory ?? 0) / 2 ** 30)} GiB · ${c.runtime ?? ""}` };
  } catch {}
  const slots = {};
  for (const l of (parts.slots || "").split("\n")) { const m = /^(\d)\s+(.+)$/.exec(l.trim()); if (m) slots[m[1]] = m[2]; }
  const tilts = [];
  for (const p of PORTS) {
    const raw = parts[`tilt ${p}`];
    if (!raw) continue;
    try {
      const rs = JSON.parse(raw); // [[name, runtimeStatus, updateStatus], ...]
      if (!Array.isArray(rs) || !rs.length) continue;
      const busy = (v) => v === "pending" || v === "in_progress";
      const errors = rs.filter(([, r, u]) => r === "error" || u === "error").map(([n]) => n);
      const pending = rs.filter(([, r, u]) => busy(r) || busy(u)).length;
      const slot = String(p - 10350);
      const where = slots[slot] ? slots[slot].split("/").pop() : null;
      tilts.push({ port: p, slot, where, errors, pending, total: rs.length });
    } catch {}
  }
  return { docker, tilts };
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.probe(cx);
    cx.timer.every(EVERY, (cx) => this.probe(cx));
  }

  probe(cx) {
    if (this.busy) return;
    this.busy = true;
    const on = spaces().find((s) => s.active)?.machine ?? null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-lc", PROBE], { ...(on ? { on } : {}), timeout: 20000 });
        this.dev = { on, ...parse(r.stdout ?? "") };
      } catch { this.dev = { on, docker: null, tilts: [], away: true }; }
      this.busy = false;
      cx.notify();
    });
  }

  devTools(t) {
    const d = this.dev;
    if (!d) return [];
    const dot = (c) => div().size(6).rounded(3).flex_none().bg(c);
    const items = [];
    if (d.docker) items.push(h_flex().id("docker").gap(6).items_center().tooltip(`Colima: ${d.docker.detail}`)
      .child(dot(d.docker.running ? t.done : t.blocked)).child(d.docker.running ? "docker" : "docker stopped"));
    for (const x of d.tilts) {
      const color = x.errors.length ? t.blocked : x.pending ? t.working : t.done;
      const text = x.errors.length ? `${x.errors.length} error${x.errors.length > 1 ? "s" : ""}` : x.pending ? `${x.pending} updating` : "ok";
      const tip = [`Tilt slot ${x.slot} · port ${x.port}`, x.where, x.errors.length ? `errors: ${x.errors.join(", ")}` : `${x.total} resources ok`, d.on ? `Runs on ${d.on}: open localhost:${x.port} there` : "Click to open the Tilt UI"].filter(Boolean).join("\n");
      items.push(h_flex().id(`tilt-${x.port}`).gap(6).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
        .tooltip(tip)
        // Tilt listens on 127.0.0.1 only, so its UI opens only on the machine it runs on.
        .on_click(() => { if (!d.on) exec("open", [`http://localhost:${x.port}`]); })
        .child(dot(color))
        .child(`tilt ${x.slot}${x.where ? ` ${x.where.length > 22 ? x.where.slice(0, 21) + "…" : x.where}` : ""}`)
        .child(div().text_color(x.errors.length ? t.blocked : t.dim).child(text)));
    }
    return items;
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .children(this.devTools(t))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
