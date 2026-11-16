// Agents as a grid of colored tiles: one square per agent, labeled with its
// space's initials, colored by status. What needs you comes first and stands out:
// blocked (solid red, pulsing ring), then done (solid green), each with how long it has
// waited; then the rest by most recent activity. Agents on another machine get its
// initial in the top-left corner. Hover for the name, click to go there.
//
// Coming back: when the window becomes active again after AWAY_MS, a "While you were
// away" dialog lists what finished or got blocked meanwhile. The Dock badge shows how
// many agents need you.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, theme, run, layout, setAgentOrder, shared, setShared, window, setBadge, openOverlay, closeOverlay, props } from "herdr";

const AWAY_MS = 2 * 60_000;
const NEEDS = { blocked: 2, done: 1 };
const ago = (ms) => { const m = Math.round(ms / 60_000); return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`; };

const TILE = 38;
const GAP = 6;
const RANK = { blocked: 3, done: 2, working: 1, idle: 0 };
const NOISE = new Set(["feature", "feat", "fix", "bugfix", "hotfix", "chore", "refactor", "docs", "test"]);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const sidebarWidth = () => find(layout(), "sidebar")?.size?.px ?? Infinity;
const narrow = () => sidebarWidth() < 160;

// Same as the shipped agents list: back to the width it had.
function expandSidebar() {
  setShared("sidebar.collapsed", false);
  run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 268 });
}

// "my-shop-api" -> MS, "feature-eng-1712-…" -> E1, "portal" -> PO.
export function initials(name) {
  const words = (name ?? "").split(/[\s\-_/.]+/).filter(Boolean);
  while (words.length > 1 && NOISE.has(words[0].toLowerCase())) words.shift();
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// "#rrggbb" + alpha 0..1 -> "#rrggbbaa".
function alpha(hex, a) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? "")) return hex;
  return hex + Math.round(a * 255).toString(16).padStart(2, "0");
}

export default class AgentTiles extends View {
  init(_props, cx) {
    this.since = {}; // address -> { status, at }: when it got its current status (null: before we looked)
    if (props()?.away) return; // the dialog copy
    this.active = window()?.active ?? true;
    this.leftAt = this.active ? null : Date.now();
    cx.timer.every(2000, (cx) => this.watchWindow(cx));
  }

  // Remember when each agent changed status; the first sighting has no time.
  track(all) {
    const now = Date.now(), seen = new Set();
    for (const a of all) {
      seen.add(a.address);
      const s = this.since[a.address];
      if (!s) this.since[a.address] = { status: a.status, at: null };
      else if (s.status !== a.status) this.since[a.address] = { status: a.status, at: now };
    }
    for (const k of Object.keys(this.since)) if (!seen.has(k)) delete this.since[k];
  }

  watchWindow(cx) {
    const active = window()?.active ?? true;
    if (active === this.active) return;
    this.active = active;
    if (!active) { this.leftAt = Date.now(); return; }
    const left = this.leftAt;
    this.leftAt = null;
    if (!left || Date.now() - left < AWAY_MS) return;
    const changed = agents().filter((a) => NEEDS[a.status] && (this.since[a.address]?.at ?? 0) >= left)
      .map((a) => ({ address: a.address, pane: a.pane, space: a.space_name, status: a.status, title: a.title, at: this.since[a.address].at }));
    if (!changed.length) return;
    changed.sort((x, y) => NEEDS[y.status] - NEEDS[x.status] || x.at - y.at);
    openOverlay({ mod: "agent-tiles", kind: "dialog", width: 440, height: Math.min(120 + changed.length * 40, 460),
      props: { away: { since: left, items: changed } } });
  }

  // The dialog copy: what finished or got blocked while you were away.
  awayDialog(t) {
    const { since, items } = props().away;
    const now = Date.now();
    const go = (it) => { closeOverlay(props().overlay); run("pane.focus", { pane: it.pane }); };
    return v_flex().size_full().p(16).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(v_flex().gap(2)
        .child(div().text_size(15).font_semibold().child("While you were away"))
        .child(div().text_size(11.5).text_color(t.dim).child(`${ago(now - since)} · ${items.filter((i) => i.status === "blocked").length} waiting for you · ${items.filter((i) => i.status === "done").length} finished`)))
      .child(v_flex().id("away-list").flex_1().min_h(0).gap(4).overflow_y_scrollbar()
        .children(items.map((it, i) => h_flex().id(`away-${i}`).h(36).px(10).gap(10).flex_none().items_center().rounded(7).cursor_pointer()
          .bg(t.raised).border_1().border_color(it.status === "blocked" ? t.blocked : t.border).hover((s) => s.bg(t.hover))
          .on_click(() => go(it))
          .child(div().size(9).rounded(5).flex_none().bg(t[it.status]))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().font_medium().child(it.space))
            .child(div().truncate().text_size(11).text_color(t.dim).child(it.title || "")))
          .child(div().flex_none().text_size(11).text_color(t[it.status]).child(it.status === "blocked" ? "waiting" : "done"))
          .child(div().flex_none().w(40).text_size(11).text_color(t.dim).child(ago(now - it.at))))))
      .child(h_flex().gap(8).justify_end()
        .child(div().id("away-close").px(10).h(26).flex().items_center().rounded(6).cursor_pointer().bg(t.raised).border_1().border_color(t.border)
          .on_click(() => closeOverlay(props().overlay)).child("Close"))
        .child(div().id("away-first").px(10).h(26).flex().items_center().rounded(6).cursor_pointer().bg(t.solid).text_color(t.solid_foreground)
          .on_click(() => go(items[0])).child(items[0].status === "blocked" ? "Go to the first waiting" : "Go to the first")));
  }

  render() {
    const t = theme();
    if (props()?.away) return this.awayDialog(t);
    const all = agents();
    this.track(all);
    const now = Date.now();
    // What needs you first (blocked, then done, longest waiting first), then by activity:
    // the agent whose status changed most recently (higher seq) leads.
    const waited = (a) => this.since[a.address]?.at ?? 0;
    const list = [...all].sort((x, y) => (NEEDS[y.status] ?? 0) - (NEEDS[x.status] ?? 0)
      || (NEEDS[x.status] ? waited(x) - waited(y) : 0) || y.seq - x.seq);
    setAgentOrder(list.map((a) => a.address));
    const needs = list.filter((a) => NEEDS[a.status]);
    const badge = needs.length ? String(needs.length) : null;
    if (badge !== this.badge) { this.badge = badge; setBadge(badge); }

    // A space with several agents: each tile also shows its tab number.
    const perSpace = new Map();
    for (const a of list) perSpace.set(a.space, (perSpace.get(a.space) ?? 0) + 1);

    const counts = {};
    for (const a of list) counts[a.status] = (counts[a.status] ?? 0) + 1;
    const urgent = counts.blocked ? "blocked" : "done";
    const summary = [
      ...(needs.length ? [div().id("needs").px(7).h(20).flex().items_center().rounded(10).bg(t[urgent]).text_color(t.background).font_semibold()
        .cursor_pointer().tooltip("Go to the one that has waited longest").on_click(() => run("pane.focus", { pane: needs[0].pane }))
        .child(`${needs.length} need${needs.length > 1 ? "" : "s"} you`)] : []),
      ...(counts.working ? [div().text_color(t.working).child(`${counts.working} working`)] : []),
    ];

    const tile = (a) => {
      const color = t[a.status] ?? t.unknown ?? t.dim;
      const idle = a.status === "idle" || !RANK[a.status];
      const need = Boolean(NEEDS[a.status]);
      const fill = idle ? t.raised : need ? color : alpha(color, 0.22);
      const at = this.since[a.address]?.at;
      const label = initials(a.space_name);
      const many = perSpace.get(a.space) > 1;
      // An agent on another machine has an address like "mini/t7": mark the tile with it.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const tip = [a.space_name, machine ? `on ${machine}` : null, many ? `tab ${a.tab_name || a.tab_index + 1}` : null,
        need && at ? `${a.status === "blocked" ? "waiting" : "done"} ${ago(now - at)}` : a.status, a.title]
        .filter(Boolean)
        .join(" · ");
      return div()
        .id(`tile-${a.address}`)
        .relative()
        .w(TILE)
        .h(TILE)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(7)
        .bg(fill)
        .border(a.focused ? 2 : 1)
        .border_color(a.focused ? t.accent : idle ? t.border : color)
        .text_size(12.5)
        .font_semibold()
        .text_color(idle ? t.dim : need ? t.background : t.foreground)
        .cursor_pointer()
        .hover((s) => s.bg(idle ? t.hover : need ? alpha(color, 0.8) : alpha(color, 0.45)))
        .tooltip(tip)
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .child(label)
        // Blocked: a ring pulsing around the tile, so it's seen from across the room.
        .when(a.status === "blocked", (el) =>
          el.child(div().absolute().top(-4).left(-4).w(TILE + 8).h(TILE + 8).rounded(10).border(2).border_color(color)
            .loop("opacity", { from: 0.15, to: 1, period: 1000 })),
        )
        .when(need && Boolean(at), (el) =>
          el.child(div().absolute().bottom(1).left(3).text_size(8.5).font_semibold().text_color(t.background).child(ago(now - at))),
        )
        .when(a.status === "working", (el) =>
          el.child(
            div().absolute().top(4).right(4).w(6).h(6).rounded(3).bg(color)
              .loop("opacity", { from: 0.25, to: 1, period: 1200 }),
          ),
        )
        .when(Boolean(machine), (el) =>
          el.child(div().absolute().top(1).left(3).text_size(8.5).font_semibold().text_color(t.accent).child(machine.slice(0, 1).toUpperCase())),
        )
        .when(many, (el) =>
          el.child(div().absolute().bottom(1).right(4).text_size(9).text_color(need ? t.background : t.dim).child(String(a.tab_index + 1))),
        );
    };

    const grid = h_flex()
      .flex_wrap()
      .gap(GAP + 2)
      .p(4)
      .when(narrow(), (el) => el.justify_center())
      .children(list.map(tile));

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .when(!narrow(), (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(36)
            .pt(12)
            .pb(4)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(h_flex().gap(8).text_size(11).children(summary)),
        ),
      )
      .child(
        div()
          .id("tiles")
          .flex_1()
          .min_h(0)
          .px(narrow() ? 4 : 14)
          .pt(narrow() ? 8 : 4)
          .pb(8)
          .overflow_y_scrollbar()
          .when(list.length > 0, (el) => el.child(grid))
          .when(list.length === 0 && !narrow(), (el) =>
            el.child(div().text_size(12).text_color(t.dim).child("No agents running.")),
          ),
      )
      .when(narrow(), (el) =>
        el.child(
          h_flex().h(28).flex_none().items_center().justify_center().child(
            div()
              .id("expand")
              .text_size(13)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click(expandSidebar)
              .child("»"),
          ),
        ),
      );
  }
}
