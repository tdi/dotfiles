// Linear: your team's active issues, each linked to the space working on its branch.
// Start opens a git worktree on the issue's Linear branch (based on the default branch)
// as a new space, optionally with Claude and the issue as its first message.
//
// Config: the herdr plugin's file (~/.config/herdr/plugins/config/tdi.worktree-from-linear/
// config.json, or config.yml holding JSON), else LINEAR_API_KEY from the environment.
// Keys used: linearApiKey, teamKey, issueLimit, assignedToMe, includeTriage, base, repos,
// worktreeRoot (default ~/.herdr/worktrees; checkouts go to <root>/<repo>/<branch slug>),
// agentMachine: the machine heavy work goes to (worktree + Claude), e.g. "mini". Viewed
// from another computer connected to it, Start makes the worktree and space there;
// "Here (light)" starts on the computer you're at. Repos given in `repos` are paths on
// agentMachine. The team-eng skill buttons show only for repos whose origin is the
// Bitropy GitHub org.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, TextView } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, home, readTextFile, knownAgents, machines, setShared } from "herdr";

const ENDPOINT = "https://api.linear.app/graphql";
const REFRESH_MS = 5 * 60_000;
const STATE_ORDER = { started: 0, unstarted: 1, triage: 2, backlog: 3 };
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const tilde = (p) => (p && p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
const BITROPY = /github\.com[:/]bitropy\//i;
const SKILLS = [
  { id: "spec-draft", label: "Spec draft", task: (i) => `/team-eng:spec-draft ${i.identifier}` },
  { id: "spec-loop", label: "Spec loop", task: (i) => `/team-eng:spec-loop ${i.identifier}` },
  { id: "spec-implement", label: "Implement spec", task: (i) => `/team-eng:spec-implement docs/specs/${i.identifier}.md` },
];

// $HOME on a machine (null = here), asked once.
const homes = new Map();
async function homeOn(on) {
  if (!on) return home();
  if (!homes.has(on)) {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on }).catch(() => null);
    if (!r || r.code !== 0 || !r.stdout.trim()) throw new Error(`Can't reach ${on}.`);
    homes.set(on, r.stdout.trim());
  }
  return homes.get(on);
}
const expand = async (p, on) => (p ? p.replace(/^~(?=\/|$)/, await homeOn(on)) : p);

// Main checkouts of Bitropy repos in ~/Projects on machine `on`: [{ name, main, on, bitropy }].
async function bitropyRepos(on) {
  const r = await exec("sh", ["-c", 'for d in "$HOME"/Projects/*/; do [ -d "$d.git" ] || continue; u=$(git -C "$d" config --get remote.origin.url 2>/dev/null) || continue; printf "%s\\t%s\\n" "${d%/}" "$u"; done'],
    { ...(on ? { on } : {}), timeout: 20000 }).catch(() => null);
  if (!r || r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.split("\t")).filter(([d, u]) => d && BITROPY.test(u ?? ""))
    .map(([main]) => ({ main, name: main.split("/").pop(), on, bitropy: true }));
}

// ---------- config ----------

const lenientJson = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));

// The config file here, else on a connected machine (the agent machine keeps the key).
async function loadConfig() {
  const rel = ".config/herdr/plugins/config/tdi.worktree-from-linear";
  let config = {}, source = null;
  const places = [null, ...machines().filter((m) => m.name && !m.temporary && m.layout !== "unavailable").map((m) => m.name)];
  search: for (const on of places) {
    const dir = `${await homeOn(on).catch(() => null)}/${rel}`;
    if (dir.startsWith("null")) continue;
    for (const name of ["config.json", "config.yml"]) {
      const text = await readTextFile(`${dir}/${name}`, on ? { on } : undefined).catch(() => null);
      if (text === null) continue;
      try { config = lenientJson(text); source = `${on ? `${on}:` : ""}${dir}/${name}`; break search; }
      catch (e) { throw new Error(`${tilde(dir)}/${name} is not valid JSON: ${e.message ?? e}`); }
    }
  }
  const dir = `~/${rel}`;
  let key = config.linearApiKey;
  if (!key) {
    for (const [sh, args] of [["sh", ["-c"]], ["zsh", ["-lc"]]]) {
      const r = await exec(sh, [...args, 'printf %s "$LINEAR_API_KEY"']).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) { key = r.stdout.trim(); source = source ?? "LINEAR_API_KEY"; break; }
    }
  }
  if (!key) throw new Error(`No Linear API key: set linearApiKey in ${tilde(dir)}/config.json or export LINEAR_API_KEY.`);
  return { issueLimit: 50, base: "default", ...config, linearApiKey: key, source };
}

async function gql(config, query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: config.linearApiKey },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`Linear: ${json.errors.map((e) => e.message).join("; ").slice(0, 200)}`);
  return json.data;
}

function issuesQuery(config, mine) {
  const types = ["unstarted", "started", ...(config.includeTriage ? ["triage"] : [])];
  const parts = [`state: { type: { in: ${JSON.stringify(types)} } }`];
  if (config.teamKey) parts.push(`team: { key: { eq: ${JSON.stringify(config.teamKey)} } }`);
  if (mine) parts.push("assignee: { isMe: { eq: true } }");
  return `query($first: Int!) { issues(first: $first, orderBy: updatedAt, filter: { ${parts.join(", ")} }) {
    nodes { ${ISSUE_FIELDS} } } }`;
}

const ISSUE_FIELDS = `id identifier title branchName url priority priorityLabel
      state { name type position } assignee { displayName } team { key } labels { nodes { name } }`;
// Linear's own search, for matches beyond the loaded active issues (any state).
function searchQuery(config) {
  const team = config.teamKey ? `, filter: { team: { key: { eq: ${JSON.stringify(config.teamKey)} } } }` : "";
  return `query($t: String!) { searchIssues(term: $t, first: 25${team}) { nodes { ${ISSUE_FIELDS} } } }`;
}

const DETAIL_QUERY = `query($id: String!) { issue(id: $id) { description project { name } cycle { number name }
  comments(first: 50) { nodes { createdAt body user { displayName } } } } }`;

// ---------- git ----------

async function git(cwd, args, timeout, on) {
  const r = await exec("git", args, { cwd, ...(timeout ? { timeout } : {}), ...(on ? { on } : {}) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The main checkout of the repo `folder` is in (a linked worktree resolves to its main repo).
// { main, name, on, bitropy }: on = the machine it's on (null = here).
async function repoOf(folder, on = null) {
  if (!folder) return null;
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 0, on);
  if (!common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  const origin = await git(main, ["remote", "get-url", "origin"], 0, on);
  return { main, name: main.split("/").pop(), on, bitropy: origin.ok && BITROPY.test(origin.out) };
}

async function worktreeFor(repo, branch, on) {
  const list = await git(repo, ["worktree", "list", "--porcelain"], 0, on);
  if (!list.ok) return null;
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) return lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? null;
  }
  return null;
}

// Where the new branch starts: { ref, fetch } per config.base ("default" | "head" | a branch).
async function baseRef(repo, base, on) {
  if (base === "head") return { ref: "HEAD", fetch: null };
  let branch = base;
  if (!base || base === "default") {
    const r = await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 0, on);
    branch = (r.ok && r.out.replace(/^origin\//, "")) || "main";
  }
  return { ref: `origin/${branch}`, fetch: branch };
}

// ---------- the panel ----------

// The focused terminal's folder and the machine it's on.
const focusFolder = () => {
  const f = focused(), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const space = spaces().find((s) => s.active);
  const folder = pane?.cwd || f?.cwd || space?.folder || null;
  return folder ? { folder, on: space?.machine ?? null } : null;
};

export default class Linear extends View {
  init(_props, cx) {
    this.issues = []; this.open = null; this.details = {}; this.busy = {}; this.errors = {};
    this.repos = []; this.picked = {}; // issue id -> repo name chosen in its row
    this.mine = JSON.parse(localStorage.getItem("mine") ?? "null");
    this.filter = "";
    this.input = InputState.new({ placeholder: "Filter issues" });
    this.handle = cx.focus_handle();
    this.found = []; this.searchSeq = 0;
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value().trim().toLowerCase();
      // Ask Linear once typing pauses (400 ms), for issues not in the loaded list.
      const seq = ++this.searchSeq;
      if (this.filter.length < 2) this.found = [];
      else cx.timer.after(400, (cx) => this.search(seq, cx));
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.config = await loadConfig();
        const on = this.heavy();
        if (this.reposOn !== (on ?? "")) { this.repos = await bitropyRepos(on); this.reposOn = on ?? ""; }
        if (this.mine === null) this.mine = Boolean(this.config.assignedToMe);
        const data = await gql(this.config, issuesQuery(this.config, this.mine), { first: this.config.issueLimit });
        this.issues = data.issues.nodes.sort((a, b) =>
          (STATE_ORDER[a.state.type] ?? 9) - (STATE_ORDER[b.state.type] ?? 9) || b.state.position - a.state.position);
        this.error = null; this.at = Date.now();
        // For the CI panel's pipeline strip: each listed issue's Linear state.
        setShared("linear.states", Object.fromEntries(this.issues.map((i) => [i.identifier, i.state.name])));
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  search(seq, cx) {
    if (seq !== this.searchSeq || !this.config || this.filter.length < 2) return;
    const term = this.filter;
    this.searching = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const nodes = (await gql(this.config, searchQuery(this.config), { t: term })).searchIssues.nodes;
        if (seq !== this.searchSeq) return;
        const have = new Set(this.issues.map((i) => i.id));
        this.found = nodes.filter((i) => !have.has(i.id));
        this.searchError = null;
      } catch (e) { if (seq === this.searchSeq) this.searchError = String(e?.message ?? e); }
      finally { if (seq === this.searchSeq) { this.searching = false; cx.notify(); } }
    });
  }

  // The repo Start uses when the team isn't in config.repos: the one the focused terminal is in.
  syncRepo(cx) {
    const f = focusFolder();
    const key = f ? `${f.on ?? ""}:${f.folder}` : null;
    if (key === this.repoKey) return;
    this.repoKey = key;
    cx.spawn(async (cx) => {
      const repo = f ? await repoOf(f.folder, f.on).catch(() => null) : null;
      if (this.repoKey === key) { this.repo = repo; cx.notify(); }
    });
  }

  // Where heavy work goes: config.agentMachine when it's a connected machine, else here
  // (on that machine itself, agentMachine is this computer).
  heavy() {
    const name = this.config?.agentMachine;
    return name && machines().some((m) => m.name === name) ? name : null;
  }

  // The repo an issue goes to, by name: the one picked in its row, else the title's
  // "repo:" prefix ("portal: …"), else the focused repo when it's a Bitropy one.
  target(issue) {
    const names = new Set(this.repos.map((r) => r.name));
    if (this.picked[issue.id]) return this.picked[issue.id];
    const prefix = /^\s*([\w.-]+)\s*:/.exec(issue.title)?.[1]?.toLowerCase();
    if (prefix && names.has(prefix)) return prefix;
    if (this.repo?.bitropy) return this.repo.name;
    return null;
  }

  // The checkout to branch from on machine `on`: the issue's target repo (~/Projects/<name>
  // there), else repos[team] (paths on the agent machine), else the focused repo when it's
  // on that machine, else ~/Projects/<same name> there.
  async repoFor(issue, on) {
    const name = this.target(issue);
    if (name) {
      if (this.repo?.name === name && this.repo.on === on) return this.repo;
      const r = await repoOf(`${await homeOn(on)}/Projects/${name}`, on);
      if (r) return r;
      throw new Error(`No ~/Projects/${name} on ${on ?? "this computer"}.`);
    }
    const mapped = this.config.repos?.[issue.team.key];
    if (mapped && on === this.heavy()) {
      const r = await repoOf(await expand(mapped, on), on);
      if (!r) throw new Error(`${mapped} (repos.${issue.team.key}) is not a git repo${on ? ` on ${on}` : ""}.`);
      return r;
    }
    if (this.repo && this.repo.on === on) return this.repo;
    if (this.repo) {
      const r = await repoOf(`${await homeOn(on)}/Projects/${this.repo.name}`, on);
      if (r) return r;
      throw new Error(`No ~/Projects/${this.repo.name} on ${on ?? "this computer"}.`);
    }
    throw new Error(`Focus a terminal inside a git repo, or map team ${issue.team.key} in "repos".`);
  }

  // The space and tab whose terminal is on this issue's branch.
  linkOf(issue) {
    const branch = issue.branchName?.toLowerCase();
    if (!branch) return null;
    for (const s of spaces()) {
      const tab = s.tabs.find((t) => panes().some((p) => p.tab === t.id && p.branch?.toLowerCase() === branch));
      if (tab) return { space: s, tab };
      if (s.branch?.toLowerCase() === branch) return { space: s, tab: s.tabs.find((t) => t.active) ?? s.tabs[0] };
    }
    return null;
  }

  toggle(issue, cx) {
    this.open = this.open === issue.id ? null : issue.id;
    if (this.open && !this.details[issue.id]) {
      this.details[issue.id] = { loading: true };
      cx.spawn(async (cx) => {
        try { this.details[issue.id] = (await gql(this.config, DETAIL_QUERY, { id: issue.id })).issue; }
        catch (e) { this.details[issue.id] = { error: String(e?.message ?? e) }; }
        cx.notify();
      });
    }
    cx.notify();
  }

  // opts: { agent, here, skill }. Heavy by default: on the agent machine.
  start(issue, opts, cx) {
    if (this.busy[issue.id]) return;
    const on = opts.here ? null : this.heavy();
    const where = on ? ` on ${on}` : "";
    this.busy[issue.id] = opts.agent ? `Starting Claude${where}…` : `Creating worktree${where}…`; delete this.errors[issue.id];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const branch = issue.branchName;
        if (!branch) throw new Error("This issue has no branch name in Linear.");
        const link = opts.here ? null : this.linkOf(issue);
        let argv, task;
        if (opts.agent) {
          const agents = await knownAgents(on ? { on } : undefined).catch(() => []);
          argv = agents.find((a) => a.key === "claude")?.run ?? ["claude"];
          const d = this.details[issue.id];
          task = opts.skill ? opts.skill.task(issue) : [`Work on Linear issue ${issue.identifier}: ${issue.title}`, issue.url,
            d?.description ? `\n${d.description.slice(0, 4000)}` : ""].filter(Boolean).join("\n");
        }
        // Already worked on in a space: a new tab there (its folder), or just go to it.
        if (link) {
          if (!opts.agent) { run("space.select", { id: link.space.id }); run("tab.select", { id: link.tab.id }); return; }
          run("tab.new", { space: link.space.id, name: opts.skill ? opts.skill.label : issue.identifier, argv, task });
          return;
        }
        const repo = await this.repoFor(issue, on);
        if (opts.skill && !repo.bitropy) throw new Error(`${repo.name} is not a Bitropy repo; team-eng skills run only there.`);
        if (!opts.here && !this.target(issue) && !this.config.repos?.[issue.team.key] && !this.repo) throw new Error("Pick a repo above first.");
        let path = await worktreeFor(repo.main, branch, on);
        if (!path) {
          const root = await expand(this.config.worktreeRoot ?? "~/.herdr/worktrees", on);
          path = `${root}/${repo.name}/${slug(branch)}`;
          const local = await git(repo.main, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], 0, on);
          const remote = !local.ok && (await git(repo.main, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], 0, on)).ok;
          let args;
          if (local.ok || remote) args = ["worktree", "add", path, branch];
          else {
            const base = await baseRef(repo.main, this.config.base, on);
            if (base.fetch) {
              this.busy[issue.id] = `Fetching origin/${base.fetch}${where}…`; cx.notify();
              const f = await git(repo.main, ["fetch", "origin", base.fetch], 120_000, on);
              if (!f.ok) throw new Error(`git fetch origin ${base.fetch}: ${f.err.split("\n").pop()}`);
            }
            // --no-track: the branch shouldn't push to the base branch.
            args = ["worktree", "add", "--no-track", "-b", branch, path, base.ref];
          }
          const add = await git(repo.main, args, 120_000, on);
          if (!add.ok) throw new Error(`git worktree add: ${add.err.split("\n").pop()}`);
        }
        run("space.new", { folder: path, name: issue.identifier, argv, task, machine: on ?? "" });
      } catch (e) { this.errors[issue.id] = String(e?.message ?? e); }
      finally { delete this.busy[issue.id]; cx.notify(); }
    });
  }

  // ---------- drawing ----------

  button(id, label, t, primary, action) {
    return div().id(id).h(24).px(9).flex().flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .border_1().border_color(primary ? t.solid : t.border).hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  statusDot(status, t) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
    return div().size(7).flex_none().rounded(4).bg(t[status] ?? t.idle);
  }

  expanded(issue, link, t) {
    const d = this.details[issue.id] ?? {};
    const meta = [issue.state.name, issue.assignee?.displayName ?? "Unassigned", issue.priority ? issue.priorityLabel : null,
      d.project?.name, d.cycle ? `Cycle ${d.cycle.name || d.cycle.number}` : null, ...issue.labels.nodes.map((l) => l.name)].filter(Boolean);
    const body = d.loading ? "_Loading…_" : d.error ? `**${d.error}**` : (d.description?.trim() || "_No description._");
    const comments = d.comments?.nodes ?? [];
    return v_flex().gap(8).px(10).pb(10).pt(2)
      .child(div().text_size(11).text_color(t.muted).child(meta.join(" · ")))
      .child(h_flex().gap(6).flex_wrap()
        .when(Boolean(link), (el) => el.child(this.button(`go-${issue.id}`, `Go to ${link.space.name}`, t, true,
          () => { run("space.select", { id: link.space.id }); run("tab.select", { id: link.tab.id }); })))
        .when(!link, (el) => el
          .child(this.button(`wt-${issue.id}`, "Worktree", t, true, (cx) => this.start(issue, {}, cx)))
          .child(this.button(`cl-${issue.id}`, "Worktree + Claude", t, false, (cx) => this.start(issue, { agent: true }, cx))))
        .when(Boolean(this.heavy()), (el) => el.child(this.button(`here-${issue.id}`, "Here (light)", t, false,
          (cx) => this.start(issue, { agent: true, here: true }, cx))))
        .child(this.button(`url-${issue.id}`, "Open in Linear", t, false, () => exec("open", [issue.url]))))
      .when(!link && this.repos.length > 0, (el) => el.child(h_flex().gap(4).flex_wrap().items_center()
        .child(div().text_size(10.5).text_color(t.dim).pr(2).child("repo"))
        .children(this.repos.map((r) => {
          const on = this.target(issue) === r.name;
          return div().id(`repo-${issue.id}-${r.name}`).px(6).h(20).flex().items_center().rounded(5).text_size(11).cursor_pointer()
            .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.picked[issue.id] = r.name; cx.notify(); })
            .child(r.name);
        }))))
      .when(Boolean(link ? this.repo?.bitropy || this.target(issue) : this.target(issue)), (el) => el.child(h_flex().gap(6).flex_wrap().items_center()
        .child(div().text_size(10.5).text_color(t.dim).child("team-eng"))
        .children(SKILLS.map((k) => this.button(`${k.id}-${issue.id}`, k.label, t, false,
          (cx) => this.start(issue, { agent: true, skill: k }, cx))))))
      .when(Boolean(this.busy[issue.id]), (el) => el.child(div().text_size(11).text_color(t.working).child(this.busy[issue.id])))
      .when(Boolean(this.errors[issue.id]), (el) => el.child(div().text_size(11).text_color(t.blocked).child(this.errors[issue.id])))
      .child(div().text_size(12).text_color(t.foreground).child(TextView.markdown(`md-${issue.id}`, body).selectable(true)))
      .when(comments.length > 0, (el) => el.child(v_flex().gap(6).pt(4).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child(`${comments.length} comments`))
        .children(comments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c, i) => v_flex().gap(2)
          .child(div().text_size(11).text_color(t.muted).child(`${c.user?.displayName ?? "someone"} · ${c.createdAt.slice(0, 10)}`))
          .child(div().text_size(12).child(TextView.markdown(`c-${issue.id}-${i}`, c.body ?? "").selectable(true)))))));
  }

  row(issue, t) {
    const link = this.linkOf(issue), open = this.open === issue.id;
    const status = link ? link.tab.status ?? link.space.status : null;
    return v_flex().flex_none().rounded(7).when(open, (e) => e.bg(t.raised).border_1().border_color(t.border))
      .child(h_flex().id(`issue-${issue.id}`).h(30).px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(issue, cx))
        .child(div().w(68).flex_none().truncate().text_size(11).text_color(t.dim).child(issue.identifier))
        .child(div().flex_1().min_w(0).truncate().text_color(link ? t.foreground : t.muted).child(issue.title))
        .when(Boolean(this.busy[issue.id]), (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.muted).spin(900)))
        .when(Boolean(link), (e) => e.child(h_flex().id(`link-${issue.id}`).gap(5).items_center().flex_none().px(5).h(20).rounded(5)
          .border_1().border_color(t.border).text_size(10.5).text_color(t.muted).hover((s) => s.bg(t.selected))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("space.select", { id: link.space.id }); run("tab.select", { id: link.tab.id }); })
          .when(Boolean(status), (el) => el.child(this.statusDot(status, t)))
          .child(div().max_w(90).truncate().child(link.space.name)))))
      .when(open, (e) => e.child(this.expanded(issue, link, t)));
  }

  render(cx) {
    this.syncRepo(cx);
    const t = theme();
    const f = this.filter;
    const shown = this.issues.filter((i) => !f || `${i.identifier} ${i.title} ${i.assignee?.displayName ?? ""} ${i.state.name}`.toLowerCase().includes(f));
    const groups = [];
    for (const i of shown) {
      const last = groups[groups.length - 1];
      if (last?.name === i.state.name) last.items.push(i); else groups.push({ name: i.state.name, type: i.state.type, items: [i] });
    }
    const chip = (id, label, on, action) => div().id(id).px(7).h(22).flex().items_center().rounded(6).text_size(11).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => action(cx)).child(label);
    const found = f.length >= 2 ? this.found : [];
    const empty = this.error ?? (this.loading ? "Loading issues…" : this.searching ? "Searching Linear…" : this.issues.length ? "No issues match" : "No active issues");
    return v_flex().id("linear").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Linear"))
        .when(Boolean(this.config?.teamKey), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(this.config.teamKey)))
        .child(div().text_size(11).text_color(t.dim).child(`${shown.length}`))
        .child(div().flex_1())
        .child(chip("mine", "Mine", Boolean(this.mine), (cx) => { this.mine = !this.mine; localStorage.setItem("mine", JSON.stringify(this.mine)); this.refresh(cx); }))
        .child(div().id("refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
          .child(this.loading ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900) : div().child("↻"))))
      .child(h_flex().flex_none().px(10).py(8).gap(8).border_b(1).border_color(t.border)
        .child(div().id("filter").flex_1().min_w(0).h(28).px(9).flex().items_center().rounded(7).border_1()
          .border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("linear-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .children(groups.flatMap((g) => [
            h_flex().id(`g-${g.name}`).flex_none().px(8).pt(8).pb(3).gap(6).text_size(10.5).text_color(t.dim)
              .child(div().size(6).rounded(3).bg(g.type === "started" ? t.working : g.type === "triage" ? t.blocked : t.idle))
              .child(div().child(g.name.toUpperCase())).child(div().child(String(g.items.length))),
            ...g.items.map((i) => this.row(i, t)),
          ]))
          .when(found.length > 0 || (f.length >= 2 && this.searching), (e) => e.children([
            h_flex().id("g-search").flex_none().px(8).pt(10).pb(3).gap(6).text_size(10.5).text_color(t.dim)
              .child(div().child("MORE IN LINEAR")).child(div().child(this.searching ? "…" : String(found.length))),
            ...found.map((i) => this.row(i, t)),
          ]))
          .when(Boolean(this.searchError) && f.length >= 2, (e) => e.child(div().px(8).text_size(11).text_color(t.blocked).child(this.searchError)))
          .when(!shown.length && !found.length, (e) => e.child(div().p(8).text_color(this.error ? t.blocked : t.dim).child(empty))))
        .child(Scrollbar.vertical("linear-list").absolute().inset_0()))
      .child(h_flex().flex_none().h(28).px(12).gap(6).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.repo
          ? `New worktrees from ${this.repo.name}${this.heavy() ? ` on ${this.heavy()}` : ""}${this.repo.bitropy ? " · Bitropy" : ""}`
          : "Pick a repo in an issue, or focus a repo's terminal"))
        .when(Boolean(this.at), (e) => e.child(div().flex_none().child(new Date(this.at).toTimeString().slice(0, 5)))));
  }
}
