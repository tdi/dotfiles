// PRs: the open pull requests (GitHub, gh) or merge requests (GitLab, glab) of the focused
// terminal's repo. Filter All / Mine / To review; expand one for Worktree (a git worktree
// on its branch as a new space, or go to the one that exists), Worktree + Claude (asks
// Claude to review it) and Open. Same-repo PRs check out their real branch (tracking
// origin); fork PRs fetch pull/<N>/head (GitLab: merge-requests/<N>/head) into pr-<N>.
// Worktrees go to WORKTREE_ROOT/<repo>/<branch slug> on the repo's machine; my-spaces
// then runs worktree-setup.toml in them.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, knownAgents, layout } from "herdr";

const WORKTREE_ROOT = "~/Projects/worktrees";
const LIMIT = 50;
const EVERY = 2 * 60_000;
const slug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const FILTERS = [["all", "All"], ["mine", "Mine"], ["review", "To review"]];

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on: space?.machine ?? null };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const r = find(c, id); if (r) return r; }
  return null;
}
// Poll only while shown (a stack child of my-main's side panel).
function shown() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  if (!panel || !body?.children?.some((c) => c.id === "prs")) return true;
  return !panel.hidden && body.active === "prs";
}

const sh = async (cmd, args, opts) => {
  try { const r = await exec(cmd, args, opts); return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() }; }
  catch (e) { return { ok: false, out: "", err: String(e?.message ?? e) }; }
};
const lastLine = (s) => s.split("\n").filter(Boolean).pop() ?? s;

// Each provider lists items as { n, title, author, branch, fork, draft, review, url, updated }.
const providers = {
  github: {
    noun: "PR", tag: "#",
    async list(cwd, on, filter) {
      const extra = filter === "mine" ? ["--author", "@me"] : filter === "review" ? ["--search", "review-requested:@me"] : [];
      const r = await sh("gh", ["pr", "list", "--limit", String(LIMIT), ...extra, "--json",
        "number,title,author,headRefName,isCrossRepository,isDraft,reviewDecision,url,updatedAt"], { cwd, on, timeout: 30_000 });
      if (!r.ok) throw new Error(`gh pr list: ${lastLine(r.err)}`);
      return JSON.parse(r.out).map((p) => ({ n: p.number, title: p.title, author: p.author?.login ?? "", branch: p.headRefName,
        fork: p.isCrossRepository, draft: p.isDraft, review: p.reviewDecision, url: p.url, updated: p.updatedAt }));
    },
    forkRef: (n) => `pull/${n}/head`,
  },
  gitlab: {
    noun: "MR", tag: "!",
    async list(cwd, on, filter) {
      const extra = filter === "mine" ? ["--author=@me"] : filter === "review" ? ["--reviewer=@me"] : [];
      const r = await sh("glab", ["mr", "list", "--per-page", String(LIMIT), ...extra, "-F", "json"], { cwd, on, timeout: 30_000 });
      if (!r.ok) throw new Error(`glab mr list: ${lastLine(r.err)}`);
      return JSON.parse(r.out).map((m) => ({ n: m.iid, title: m.title, author: m.author?.username ?? "", branch: m.source_branch,
        fork: m.source_project_id !== m.target_project_id, draft: m.draft || m.work_in_progress, review: null, url: m.web_url, updated: m.updated_at }));
    },
    forkRef: (n) => `merge-requests/${n}/head`,
  },
};

const REVIEW = { APPROVED: ["approved", "ansi2"], CHANGES_REQUESTED: ["changes", "blocked"], REVIEW_REQUIRED: ["review", "working"] };

export default class Prs extends View {
  init(_props, cx) {
    this.items = []; this.open = null; this.busy = {}; this.errors = {};
    this.filter = localStorage.getItem("filter") ?? "all";
    this.text = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Filter" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    cx.timer.every(10_000, (cx) => { if (shown() && Date.now() - (this.at ?? 0) > EVERY) this.refresh(cx); });
  }

  refresh(cx) {
    if (this.loading) return;
    const loc = location(), context = JSON.stringify([loc, this.filter]);
    if (context !== this.context) { this.context = context; this.items = []; this.error = null; this.repo = null; }
    if (!loc.cwd) { this.error = "No folder"; return; }
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { cwd, on } = loc;
        const top = await sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
        if (!top.ok) throw new Error("Not a git repository");
        const main = top.out.endsWith("/.git") ? top.out.slice(0, -5) : top.out;
        const url = (await sh("git", ["remote", "get-url", "origin"], { cwd: main, on })).out;
        if (!url) throw new Error("No origin remote");
        const provider = /gitlab/i.test(url) ? "gitlab" : "github";
        const items = await providers[provider].list(main, on, this.filter);
        if (JSON.stringify([location(), this.filter]) !== context) return;
        Object.assign(this, { items, provider, repo: { main, name: main.split("/").pop(), on }, error: null });
      } catch (e) { if (JSON.stringify([location(), this.filter]) === context) this.error = String(e?.message ?? e); }
      finally { this.loading = false; this.at = Date.now(); cx.notify(); }
    });
  }

  // The space whose terminal is on this branch (or the review copy pr-<N>).
  linkOf(item) {
    const names = new Set([item.branch, `pr-${item.n}`].map((b) => b.toLowerCase()));
    for (const s of spaces()) {
      const tab = s.tabs.find((t) => panes().some((p) => p.tab === t.id && names.has(p.branch?.toLowerCase() ?? "")));
      if (tab) return { space: s, tab };
      if (names.has(s.branch?.toLowerCase() ?? "")) return { space: s, tab: s.tabs.find((t) => t.active) ?? s.tabs[0] };
    }
    return null;
  }

  go(link) { run("space.select", { id: link.space.id }); run("tab.select", { id: link.tab.id }); }

  start(item, withAgent, cx) {
    if (this.busy[item.n] || !this.repo) return;
    const { main, name, on } = this.repo, p = providers[this.provider];
    const git = (args, timeout) => sh("git", args, { cwd: main, on, ...(timeout ? { timeout } : {}) });
    this.busy[item.n] = "Creating worktree…"; delete this.errors[item.n]; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const branch = item.fork ? `pr-${item.n}` : item.branch;
        const list = await git(["worktree", "list", "--porcelain"]);
        let path = list.out.split(/\n\n+/).map((b) => b.split("\n")).find((l) => l.includes(`branch refs/heads/${branch}`))?.find((l) => l.startsWith("worktree "))?.slice(9);
        if (!path) {
          const home = (await sh("sh", ["-c", 'printf %s "$HOME"'], { on })).out;
          path = `${WORKTREE_ROOT.replace(/^~(?=\/|$)/, home)}/${name}/${slug(branch)}`;
          const fetch = item.fork ? await git(["fetch", "origin", `${p.forkRef(item.n)}:${branch}`], 120_000) : await git(["fetch", "origin", item.branch], 120_000);
          if (!fetch.ok) throw new Error(`git fetch: ${lastLine(fetch.err)}`);
          const local = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
          const add = local ? await git(["worktree", "add", path, branch], 120_000)
            : await git(["worktree", "add", "--track", "-b", branch, path, `origin/${item.branch}`], 120_000);
          if (!add.ok) throw new Error(`git worktree add: ${lastLine(add.err)}`);
        }
        let argv, task;
        if (withAgent) {
          const agents = await knownAgents(on ? { on } : undefined).catch(() => []);
          argv = agents.find((a) => a.key === "claude")?.run ?? ["claude"];
          task = `Review ${p.noun} ${p.tag}${item.n}: ${item.title}\n${item.url}\nThe worktree is checked out on its branch. Read the diff against its base and report problems, most severe first.`;
        }
        const link = this.linkOf(item);
        if (link && !withAgent) { this.go(link); return; }
        if (link) run("tab.new", { space: link.space.id, name: `review ${p.tag}${item.n}`, argv, task });
        else run("space.new", { folder: path, name: `${p.tag}${item.n} ${item.branch}`.slice(0, 40), argv, task, machine: on ?? "" });
      } catch (e) { this.errors[item.n] = String(e?.message ?? e); }
      finally { delete this.busy[item.n]; cx.notify(); }
    });
  }

  button(id, label, t, primary, action) {
    return div().id(id).h(24).px(9).flex().flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .border_1().border_color(primary ? t.solid : t.border).hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  row(item, t) {
    const p = providers[this.provider], link = this.linkOf(item), open = this.open === item.n;
    const rv = REVIEW[item.review];
    return v_flex().flex_none().rounded(7).when(open, (e) => e.bg(t.raised).border_1().border_color(t.border))
      .child(h_flex().id(`pr-${item.n}`).h(30).px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.open = open ? null : item.n; cx.notify(); })
        .child(div().w(46).flex_none().text_size(11).text_color(t.dim).child(`${p.tag}${item.n}`))
        .child(div().flex_1().min_w(0).truncate().text_color(item.draft ? t.muted : t.foreground).child(item.title))
        .when(Boolean(this.busy[item.n]), (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.muted).spin(900)))
        .when(Boolean(rv), (e) => e.child(div().flex_none().text_size(10.5).text_color(t[rv[1]]).child(rv[0])))
        .when(Boolean(link), (e) => e.child(div().flex_none().size(7).rounded(4).bg(t.accent))))
      .when(open, (e) => e.child(v_flex().gap(8).px(10).pb(10).pt(2)
        .child(div().text_size(11).text_color(t.muted).child([item.author, item.branch, item.fork ? "fork" : null, item.draft ? "draft" : null,
          item.updated ? `updated ${item.updated.slice(0, 10)}` : null].filter(Boolean).join(" · ")))
        .child(h_flex().gap(6).flex_wrap()
          .when(Boolean(link), (el) => el.child(this.button(`go-${item.n}`, `Go to ${link.space.name}`, t, true, () => this.go(link))))
          .when(!link, (el) => el.child(this.button(`wt-${item.n}`, "Worktree", t, true, (cx) => this.start(item, false, cx))))
          .child(this.button(`cl-${item.n}`, link ? "Review with Claude" : "Worktree + Claude", t, false, (cx) => this.start(item, true, cx)))
          .child(this.button(`url-${item.n}`, "Open", t, false, () => exec("open", [item.url]))))
        .when(Boolean(this.busy[item.n]), (el) => el.child(div().text_size(11).text_color(t.working).child(this.busy[item.n])))
        .when(Boolean(this.errors[item.n]), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.errors[item.n])))));
  }

  render(cx) {
    if (JSON.stringify([location(), this.filter]) !== this.context && shown()) this.refresh(cx);
    const t = theme(), q = this.text;
    const list = this.items.filter((i) => !q || `${i.n} ${i.title} ${i.author} ${i.branch}`.toLowerCase().includes(q));
    const p = providers[this.provider];
    const chip = (id, label, on, action) => div().id(id).px(7).h(22).flex().items_center().rounded(6).text_size(11).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => action(cx)).child(label);
    const empty = this.error ?? (this.loading ? "Loading…" : this.items.length ? "Nothing matches" : `No open ${p?.noun ?? "PR"}s`);
    return v_flex().id("prs").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(p ? `${p.noun}s` : "PRs"))
        .when(Boolean(this.provider), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(this.provider === "github" ? "GitHub" : "GitLab")))
        .child(div().text_size(11).text_color(t.dim).child(String(list.length)))
        .child(div().flex_1())
        .child(div().id("prs-refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
          .child(this.loading ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900) : div().child("↻"))))
      .child(h_flex().flex_none().px(10).py(8).gap(6).items_center().border_b(1).border_color(t.border)
        .children(FILTERS.map(([id, label]) => chip(`f-${id}`, label, this.filter === id, (cx) => {
          this.filter = id; localStorage.setItem("filter", id); this.refresh(cx);
        })))
        .child(div().id("prs-filter").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(7).border_1()
          .border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("prs-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .children(list.map((i) => this.row(i, t)))
          .when(!list.length, (e) => e.child(div().p(8).text_color(this.error ? t.blocked : t.dim).child(empty))))
        .child(Scrollbar.vertical("prs-list").absolute().inset_0()))
      .child(h_flex().flex_none().h(28).px(12).gap(6).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.repo ? `${this.repo.name}${this.repo.on ? ` on ${this.repo.on}` : ""} · worktrees in ${WORKTREE_ROOT}` : "Focus a repo's terminal"))
        .when(Boolean(this.at), (e) => e.child(div().flex_none().child(new Date(this.at).toTimeString().slice(0, 5)))));
  }
}
