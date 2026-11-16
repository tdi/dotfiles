// Status bar, plus Docker (Colima) on the right, on the machine of the space you're in.
// Running dev stacks (Tilt, docker compose) are shown per space in my-spaces instead.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec } from "herdr";

const EVERY = 30000;

function parse(out) {
  try {
    const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const c = lines.find((l) => l.name === "default") ?? lines[0];
    if (c?.status) return { running: c.status === "Running", detail: `${c.name} · ${c.cpus ?? "?"} CPU · ${Math.round((c.memory ?? 0) / 2 ** 30)} GiB · ${c.runtime ?? ""}` };
  } catch {}
  return null;
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
        const r = await exec("sh", ["-lc", "colima list -j 2>/dev/null"], { ...(on ? { on } : {}), timeout: 20000 });
        this.dev = { on, docker: parse(r.stdout ?? "") };
      } catch { this.dev = { on, docker: null }; }
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
