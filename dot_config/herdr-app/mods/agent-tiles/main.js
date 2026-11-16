// Agents as a grid of colored tiles: one square per agent, labeled with its
// space's initials, colored by status. Blocked ones come first, the rest by
// most recent activity. Agents on another machine get its initial in the top-left
// corner (from the other computer, M = mini). Hover for the name, click to go there.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, theme, run, layout, setAgentOrder, shared, setShared, window } from "herdr";

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

// "whenubuy-shop-maker" -> WS, "feature-bit-1712-…" -> B1, "portal" -> PO.
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
  render() {
    const t = theme();
    const all = agents();
    // Blocked first, then by activity: the agent whose status changed most recently
    // (higher seq) leads, so busy agents sit at the front and long-idle ones drift back.
    const list = [...all].sort((x, y) => (y.status === "blocked") - (x.status === "blocked") || y.seq - x.seq);
    setAgentOrder(list.map((a) => a.address));

    // A space with several agents: each tile also shows its tab number.
    const perSpace = new Map();
    for (const a of list) perSpace.set(a.space, (perSpace.get(a.space) ?? 0) + 1);

    const counts = {};
    for (const a of list) counts[a.status] = (counts[a.status] ?? 0) + 1;
    const summary = ["blocked", "done", "working"]
      .filter((s) => counts[s])
      .map((s) => div().text_color(t[s]).child(`${counts[s]} ${s}`));

    const tile = (a) => {
      const color = t[a.status] ?? t.unknown ?? t.dim;
      const idle = a.status === "idle" || !RANK[a.status];
      const fill = idle ? t.raised : alpha(color, a.status === "working" ? 0.22 : 0.3);
      const label = initials(a.space_name);
      const many = perSpace.get(a.space) > 1;
      // An agent on another machine has an address like "mini/t7": mark the tile with it.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const tip = [a.space_name, machine ? `on ${machine}` : null, many ? `tab ${a.tab_name || a.tab_index + 1}` : null, a.status, a.title]
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
        .text_color(idle ? t.dim : t.foreground)
        .cursor_pointer()
        .hover((s) => s.bg(idle ? t.hover : alpha(color, 0.45)))
        .tooltip(tip)
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .child(label)
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
          el.child(div().absolute().bottom(1).right(4).text_size(9).text_color(t.dim).child(String(a.tab_index + 1))),
        );
    };

    const grid = h_flex()
      .flex_wrap()
      .gap(GAP)
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
