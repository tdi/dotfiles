// CI: the checks of the focused terminal's branch. GitHub: the PR's checks (`gh pr checks`),
// or the branch's latest workflow runs before there is a PR. GitLab: the branch's latest
// pipeline jobs (`glab ci get`). Polls every 10 s while anything runs, every 60 s when settled.
// Click a check to open it; failed ones get Log (a terminal below), Re-run and Fix (Claude).
// Above the checks, a pipeline strip: PR → CI → Review → Merged, and for branches with a
// ticket of your Linear team (shared "linear.teamKey", e.g. bit-123) first Spec (docs/specs, open [QUESTION]s) and
// Review loop (docs/reviews/<TICKET>-ledger.md: CONVERGED / CHURN / CAP / ERROR), last
// the Linear state (shared "linear.states", written by the linear mod).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, knownAgents, layout, readTextFile, shared } from "herdr";


// team-eng state for a ticket in the checkout `top`: its spec and review-loop ledger.
async function teamEng(top, ticket, on) {
  const ls = await sh("sh", ["-c", 'for d in docs/specs docs/reviews; do ls "$d" 2>/dev/null | sed "s|^|$d/|"; done'], { cwd: top, on });
  const files = ls.ok ? ls.out.split("\n") : [];
  const id = new RegExp(`(^|[^0-9a-z])${ticket.toLowerCase()}([^0-9]|$)`);
  const mine = (dir) => files.filter((f) => f.startsWith(dir) && id.test(f.split("/").pop().toLowerCase()));
  const read = (f) => readTextFile(`${top}/${f}`, on ? { on } : undefined).catch(() => null);
  const specFile = mine("docs/specs/").find((f) => f.endsWith(".md"));
  const ledgerFile = mine("docs/reviews/").find((f) => /ledger/i.test(f));
  let spec = null, ledger = null;
  if (specFile) {
    const text = (await read(specFile)) ?? "";
    spec = { file: specFile, questions: (text.match(/\[QUESTION/g) ?? []).length };
  }
  if (ledgerFile) {
    const text = (await read(ledgerFile)) ?? "";
    const states = text.match(/\b(CONVERGED|CHURN|CAP|ERROR)\b/g) ?? [];
    const blocking = text.split(/\n(?=### L\d+)/).filter((b) => /^### L\d+ \[(CRITICAL|HIGH)\]/.test(b) && /\*\*Status\*\*:\s*(open|reopened)\b/i.test(b)).length;
    // Untracked while a loop runs, committed when it ends: a committed ledger without a
    // termination word (older format) counts as finished.
    const tracked = (await sh("git", ["ls-files", "--error-unmatch", ledgerFile], { cwd: top, on })).ok;
    ledger = { file: ledgerFile, state: states.length ? states[states.length - 1] : tracked ? "CONVERGED" : null, blocking };
  }
  return { spec, ledger };
}

const FAST_MS = 10_000, IDLE_MS = 60_000;
const PR_FIELDS = "number,title,url,state,isDraft,mergeStateStatus,reviewDecision,baseRefName";
const CHECK_FIELDS = "name,state,bucket,link,workflow,startedAt,completedAt";
const GROUPS = [
  { bucket: "fail", label: "Failing", open: true },
  { bucket: "cancel", label: "Cancelled", open: true },
  { bucket: "pending", label: "In progress", open: true },
  { bucket: "skipping", label: "Skipped", open: false },
  { bucket: "pass", label: "Successful", open: false },
];
const ICON = { fail: "✕", cancel: "⊘", pending: "●", skipping: "⊘", pass: "✓" };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on, space: space?.id ?? null };
}

// Poll only while visible: in my-main's side panel it's a stack child, hidden most of the time.
function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}
function shown() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  if (!panel || !body?.children?.some((c) => c.id === "ci")) return true; // placed elsewhere: assume shown
  return !panel.hidden && body.active === "ci";
}

const sh = async (cmd, args, opts) => {
  try { const r = await exec(cmd, args, opts); return { ok: r.code === 0, code: r.code, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() }; }
  catch (e) { return { ok: false, code: -1, out: "", err: String(e?.message ?? e), missing: true }; }
};

function remoteHost(url) {
  const u = String(url ?? "").trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(u);
  if (scheme) return scheme[1].toLowerCase();
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)/.exec(u);
  return scp ? scp[1].toLowerCase() : null;
}

const oneLine = (s) => String(s ?? "").replace(/[✘]|\bERROR\b/g, " ").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
function explain(tool, r) {
  if (r.missing) return `${tool} is not installed (brew install ${tool})`;
  if (/auth login|not logged in|401|unauthorized|authentication required/i.test(r.err)) return `${tool} is not logged in: run \`${tool} auth login\``;
  return oneLine(r.err) || `${tool} exited ${r.code}`;
}

// Actions check links look like …/actions/runs/<run>/job/<job>.
const runJob = (link) => { const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(link || ""); return m ? { runId: m[1], jobId: m[2] ?? null } : null; };

const GL_BUCKET = { success: "pass", failed: "fail", canceled: "cancel", canceling: "cancel", skipped: "skipping", manual: "skipping" };
const runBucket = (r) => r.status !== "completed" ? "pending"
  : r.conclusion === "success" ? "pass" : r.conclusion === "skipped" || r.conclusion === "neutral" ? "skipping"
  : r.conclusion === "cancelled" ? "cancel" : "fail";

const providers = {
  github: {
    tool: "gh",
    async refresh(cwd, branch, on) {
      const pr = await sh("gh", ["pr", "view", branch, "--json", PR_FIELDS], { cwd, on, timeout: 20_000 });
      if (!pr.ok && !/no pull requests found/i.test(pr.err)) throw new Error(explain("gh", pr));
      if (pr.ok) {
        const p = JSON.parse(pr.out);
        // gh exits 8 while checks are pending and 1 when any failed, still printing the JSON.
        const c = await sh("gh", ["pr", "checks", String(p.number), "--json", CHECK_FIELDS], { cwd, on, timeout: 20_000 });
        let checks = [];
        if (c.out.startsWith("[")) checks = JSON.parse(c.out);
        else if (!/no checks reported/i.test(c.err)) throw new Error(explain("gh", c));
        return {
          target: { label: `#${p.number} ${p.title}`, url: p.url, number: p.number, state: p.state, draft: p.isDraft, merge: p.mergeStateStatus, review: p.reviewDecision, base: p.baseRefName },
          checks: checks.map((x) => ({ ...x, id: x.link || `${x.workflow}/${x.name}` })),
        };
      }
      // No PR yet: the branch's latest run of each workflow.
      const runs = await sh("gh", ["run", "list", "--branch", branch, "--limit", "20", "--json", "databaseId,workflowName,displayTitle,status,conclusion,url,createdAt,updatedAt,headSha"], { cwd, on, timeout: 20_000 });
      if (!runs.ok) throw new Error(explain("gh", runs));
      const list = JSON.parse(runs.out || "[]"), sha = list[0]?.headSha, seen = new Set();
      const latest = list.filter((r) => r.headSha === sha && !seen.has(r.workflowName) && seen.add(r.workflowName));
      return {
        target: null,
        checks: latest.map((r) => ({ id: String(r.databaseId), name: r.displayTitle, workflow: r.workflowName, bucket: runBucket(r),
          state: r.conclusion || r.status, link: r.url, startedAt: r.createdAt, completedAt: r.status === "completed" ? r.updatedAt : "" })),
      };
    },
    canAct: (c) => Boolean(runJob(c.link)),
    logCommand: (c) => { const j = runJob(c.link); return j.jobId ? `gh run view --job ${j.jobId} --log-failed` : `gh run view ${j.runId} --log-failed`; },
    rerun: (cwd, c, on) => sh("gh", ["run", "rerun", runJob(c.link).runId, "--failed"], { cwd, on }),
  },
  gitlab: {
    tool: "glab",
    async refresh(cwd, branch, on) {
      const r = await sh("glab", ["ci", "get", "-b", branch, "-F", "json", "-d"], { cwd, on, timeout: 20_000 });
      if (!r.ok) {
        if (/no pipeline found/i.test(r.err)) return { target: null, checks: [] };
        throw new Error(explain("glab", r));
      }
      const pipeline = JSON.parse(r.out);
      const mrs = await sh("glab", ["mr", "list", "--source-branch", branch, "-F", "json"], { cwd, on, timeout: 20_000 });
      let mr = null;
      try { mr = mrs.ok ? JSON.parse(mrs.out)[0] ?? null : null; } catch {}
      return {
        target: mr ? { label: `!${mr.iid} ${mr.title}`, url: mr.web_url, state: mr.state, draft: mr.draft, merge: mr.detailed_merge_status ?? mr.merge_status, base: mr.target_branch }
          : { label: `Pipeline #${pipeline.iid ?? pipeline.id} · ${pipeline.status}`, url: pipeline.web_url },
        checks: (pipeline.jobs ?? []).map((j) => {
          const allowed = j.status === "failed" && Boolean(j.allow_failure);
          return { id: String(j.id), jobId: String(j.id), name: j.name, workflow: j.stage ?? "", state: allowed ? "failed (allowed)" : j.status,
            bucket: allowed ? "pass" : GL_BUCKET[j.status] ?? "pending", link: j.web_url ?? "", startedAt: j.started_at ?? "", completedAt: j.finished_at ?? "" };
        }),
      };
    },
    canAct: (c) => Boolean(c.jobId),
    logCommand: (c) => `glab ci trace ${c.jobId}`,
    rerun: (cwd, c, on) => sh("glab", ["ci", "retry", c.jobId], { cwd, on }),
  },
};

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function since(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}
function duration(a, b) {
  const s = (Date.parse(b) - Date.parse(a)) / 1000;
  if (!(s >= 0)) return "";
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
const MERGE = { CLEAN: ["ready to merge", "pass"], HAS_HOOKS: ["ready to merge", "pass"], UNSTABLE: ["mergeable, checks not green", "pending"],
  BLOCKED: ["blocked", "pending"], BEHIND: ["behind base", "pending"], DIRTY: ["conflicts", "fail"], DRAFT: ["draft", "skipping"],
  mergeable: ["ready to merge", "pass"], can_be_merged: ["ready to merge", "pass"], conflict: ["conflicts", "fail"], cannot_be_merged: ["conflicts", "fail"],
  ci_still_running: ["CI running", "pending"], ci_must_pass: ["CI must pass", "pending"], not_approved: ["needs approval", "pending"], draft_status: ["draft", "skipping"] };
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

export default class Ci extends View {
  init(_props, cx) {
    this.checks = []; this.openGroups = Object.fromEntries(GROUPS.map((g) => [g.bucket, g.open])); this.notes = {};
    cx.timer.every(FAST_MS, (cx) => {
      if (!shown()) return;
      if (Date.now() - (this.at ?? 0) >= (this.pending ? FAST_MS : IDLE_MS) - 500) this.refresh(cx);
    });
  }

  refresh(cx) {
    if (this.loading) return;
    const loc = location(), context = JSON.stringify(loc);
    if (context !== this.context) {
      this.context = context; this.repo = null; this.branch = null; this.provider = null;
      this.target = null; this.checks = []; this.error = null; this.notes = {}; this.at = 0; this.pipe = null;
    }
    if (!loc.cwd) { this.error = "No folder"; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const { cwd, on } = loc;
        const top = await sh("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (!top.ok) throw new Error("Not a git repository");
        const branch = await sh("git", ["branch", "--show-current"], { cwd: top.out, on });
        if (!branch.out) throw new Error("Detached HEAD: check out a branch to see its CI");
        let provider = this.provider;
        if (!provider) {
          const host = remoteHost((await sh("git", ["remote", "get-url", "origin"], { cwd: top.out, on })).out);
          if (!host) throw new Error("No origin remote");
          provider = host === "github.com" ? "github" : host.includes("gitlab") ? "gitlab"
            : (await sh("glab", ["auth", "status", "--hostname", host], { cwd: top.out, on })).ok ? "gitlab" : "github";
        }
        const res = await providers[provider].refresh(top.out, branch.out, on);
        const key = shared("linear.teamKey");
        const ticket = key ? new RegExp(`(?:^|[^a-z])${key}-(\\d+)`, "i").exec(branch.out) : null;
        const pipe = { ticket: ticket ? `${key.toUpperCase()}-${ticket[1]}` : null };
        if (pipe.ticket) Object.assign(pipe, await teamEng(top.out, pipe.ticket, on));
        if (JSON.stringify(location()) !== context) return;
        Object.assign(this, { repo: top.out, on, branch: branch.out, provider, target: res.target, checks: res.checks, error: null, pipe });
        this.pending = res.checks.some((c) => c.bucket === "pending");
      } catch (e) { if (JSON.stringify(location()) === context) { this.error = String(e?.message ?? e); this.pending = false; } }
      finally { this.loading = false; this.at = Date.now(); cx.notify(); }
    });
  }

  log(c) {
    const cmd = `${providers[this.provider].logCommand(c)} 2>&1 | less -R`;
    run("terminal.open", { argv: ["sh", "-c", cmd], folder: this.repo, place: "down" });
  }

  rerun(c, cx) {
    this.notes[c.id] = "Re-running…"; cx.notify();
    const p = providers[this.provider];
    cx.spawn(async (cx) => {
      const r = await p.rerun(this.repo, c, this.on);
      this.notes[c.id] = r.ok ? "Re-run requested" : explain(p.tool, r);
      this.at = 0; cx.notify();
    });
  }

  fix(c, cx) {
    const p = providers[this.provider], where = this.target ? `on ${this.target.label.split(" ")[0]}` : `on branch ${this.branch}`;
    const task = `The CI check "${[c.workflow, c.name].filter(Boolean).join(" / ")}" failed ${where}.\n` +
      `Read its log with \`${p.logCommand(c)}\`, find the root cause, fix it, and run the relevant checks locally. ${c.link}`;
    cx.spawn(async () => {
      const agents = await knownAgents({ on: this.on }).catch(() => []);
      const argv = agents.find((a) => a.key === "claude")?.run ?? ["claude"];
      run("tab.new", { space: location().space, folder: this.repo, name: `fix ${c.name}`.slice(0, 30), argv, task });
    });
  }

  btn(id, label, t, action) {
    return div().id(id).h(20).px(7).flex().flex_none().items_center().rounded(5).text_size(10.5).cursor_pointer()
      .border_1().border_color(t.border).bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  // Stages as { label, detail, state: done | active | you | fail | todo }.
  stages(overall) {
    const tg = this.target, p = this.pipe ?? {}, out = [];
    if (p.ticket) {
      out.push(p.spec
        ? { label: "Spec", state: p.spec.questions ? "you" : "done", detail: p.spec.questions ? `${p.spec.questions} open questions` : p.spec.file }
        : { label: "Spec", state: "todo", detail: `no docs/specs file for ${p.ticket}` });
      const L = p.ledger;
      out.push(!L ? { label: "Review loop", state: "todo", detail: "no ledger yet" }
        : L.state === "CONVERGED" ? { label: "Review loop", state: "done", detail: `converged · ${L.file}` }
        : L.state ? { label: "Review loop", state: "you", detail: `${L.state.toLowerCase()}: needs your decision · ${L.file}` }
        : { label: "Review loop", state: "active", detail: `running${L.blocking ? ` · ${L.blocking} blocking open` : ""}` });
    }
    const merged = /merged/i.test(tg?.state ?? "");
    out.push(tg ? { label: "PR", state: tg.draft ? "active" : "done", detail: tg.draft ? "draft" : tg.label } : { label: "PR", state: "todo", detail: "no PR yet" });
    out.push({ label: "CI", state: overall === "pass" ? "done" : overall === "fail" ? "fail" : overall === "pending" ? "active" : "todo", detail: overall ?? "no checks" });
    const rv = tg?.review;
    out.push({ label: "Review", state: merged || rv === "APPROVED" ? "done" : rv === "CHANGES_REQUESTED" ? "fail" : tg ? "active" : "todo", detail: REVIEW[rv] ?? (tg ? "waiting" : "") });
    out.push({ label: "Merged", state: merged ? "done" : "todo", detail: merged ? "merged" : "" });
    if (p.ticket) {
      const st = shared("linear.states")?.[p.ticket];
      out.push({ label: st ?? "Linear", state: st ? (/done|released/i.test(st) ? "done" : /review/i.test(st) ? "active" : "todo") : "todo", detail: st ? `${p.ticket} in Linear: ${st}` : `${p.ticket}: not among your active Linear issues` });
    }
    return out;
  }

  pipeline(overall, t) {
    const color = { done: t.ansi2, active: t.working, you: t.blocked, fail: t.blocked, todo: t.dim };
    const mark = { done: "✓", active: "●", you: "!", fail: "✕", todo: "○" };
    const list = this.stages(overall);
    return h_flex().id("ci-pipe").flex_none().px(12).py(7).gap(4).flex_wrap().items_center().border_b(1).border_color(t.border).text_size(10.5)
      .children(list.flatMap((s, i) => [
        ...(i ? [div().text_color(t.dim).child("›")] : []),
        h_flex().id(`stage-${i}`).gap(4).items_center().px(5).h(18).rounded(4)
          .when(s.state === "you" || s.state === "fail", (el) => el.border_1().border_color(color[s.state]))
          .text_color(s.state === "todo" ? t.dim : t.foreground).tooltip(s.detail || s.label)
          .child(div().text_color(color[s.state]).child(mark[s.state])).child(s.label),
      ]));
  }

  color(bucket, t) { return { fail: t.blocked, cancel: t.muted, pending: t.working, skipping: t.dim, pass: t.ansi2 }[bucket] ?? t.muted; }

  checkRow(c, t) {
    const p = providers[this.provider];
    const when = c.bucket === "pending" ? (c.startedAt ? `${since(c.startedAt)}` : "queued")
      : c.bucket === "skipping" ? "" : duration(c.startedAt, c.completedAt);
    const actionable = (c.bucket === "fail" || c.bucket === "cancel") && p.canAct(c);
    return v_flex().flex_none()
      .child(h_flex().id(`check-${c.id}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => c.link && exec("open", [c.link]))
        .child(c.bucket === "pending" ? div().w(12).flex_none().text_color(t.working).child(div().child("●").loop("opacity", { from: 0.3, to: 1, period: 1200 }))
          : div().w(12).flex_none().text_color(this.color(c.bucket, t)).child(ICON[c.bucket] ?? "?"))
        .child(h_flex().flex_1().min_w(0)
          .when(Boolean(c.workflow), (e) => e.child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(`${c.workflow} / `)))
          .child(div().flex_shrink_0().max_w(240).truncate().child(c.name)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(when)))
      .when(actionable, (e) => e.child(h_flex().pl(28).pb(4).gap(5)
        .child(this.btn(`log-${c.id}`, "Log", t, () => this.log(c)))
        .child(this.btn(`rerun-${c.id}`, "Re-run", t, (cx) => this.rerun(c, cx)))
        .child(this.btn(`fix-${c.id}`, "Fix with Claude", t, (cx) => this.fix(c, cx)))
        .when(Boolean(this.notes[c.id]), (el) => el.child(div().text_size(10.5).text_color(t.muted).child(this.notes[c.id])))));
  }

  render(cx) {
    if (JSON.stringify(location()) !== this.context) this.refresh(cx);
    const t = theme(), tg = this.target;
    const count = (b) => this.checks.filter((c) => c.bucket === b).length;
    const summary = GROUPS.map((g) => [count(g.bucket), g]).filter(([n]) => n).map(([n, g]) => `${n} ${g.label.toLowerCase()}`).join(" · ");
    const overall = count("fail") ? "fail" : count("pending") ? "pending" : this.checks.length ? "pass" : null;
    const merge = tg?.merge ? MERGE[tg.merge] : null;
    const pill = (text, bucket) => div().px(6).h(18).flex().items_center().rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(this.color(bucket, t)).child(text);
    return v_flex().id("ci").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("CI"))
        .when(Boolean(this.provider), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(this.provider === "github" ? "GitHub" : "GitLab")))
        .when(Boolean(overall), (e) => e.child(div().size(7).rounded(4).bg(this.color(overall, t))))
        .child(div().flex_1())
        .child(div().id("ci-refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.at = 0; this.refresh(cx); })
          .child(this.loading ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900) : div().child("↻"))))
      .when(Boolean(this.branch), (e) => e.child(this.pipeline(overall, t)))
      .child(v_flex().flex_none().px(14).py(10).gap(5).border_b(1).border_color(t.border)
        .child(tg ? div().id("ci-target").font_semibold().cursor_pointer().hover((s) => s.text_color(t.accent)).on_click(() => exec("open", [tg.url])).child(tg.label)
          : div().text_color(t.muted).child(this.branch ? (this.provider === "gitlab" ? "No pipeline yet" : this.checks.length ? "No PR yet · latest workflow runs" : "No PR or runs for this branch yet") : this.loading ? "Loading…" : ""))
        .when(Boolean(this.branch), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(tg?.base ? `${this.branch} → ${tg.base}` : this.branch)))
        .when(Boolean(tg && (merge || tg.draft || REVIEW[tg.review] || (tg.state && !/open/i.test(tg.state)))), (e) => e.child(h_flex().gap(5).flex_wrap()
          .when(tg.state && !/open/i.test(tg.state), (el) => el.child(pill(tg.state.toLowerCase(), "skipping")))
          .when(Boolean(tg.draft), (el) => el.child(pill("draft", "skipping")))
          .when(Boolean(merge), (el) => el.child(pill(merge[0], merge[1])))
          .when(Boolean(REVIEW[tg.review]), (el) => el.child(pill(REVIEW[tg.review], tg.review === "APPROVED" ? "pass" : tg.review === "CHANGES_REQUESTED" ? "fail" : "pending")))))
        .when(Boolean(summary), (e) => e.child(div().text_size(11).text_color(t.muted).child(summary))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("ci-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(Boolean(this.error), (e) => e.child(div().p(8).text_color(t.blocked).child(this.error)))
          .children(GROUPS.filter((g) => count(g.bucket)).flatMap((g) => {
            const open = this.openGroups[g.bucket];
            return [
              h_flex().id(`grp-${g.bucket}`).flex_none().h(24).px(8).gap(6).items_center().rounded(5).cursor_pointer().text_size(10.5).text_color(t.dim)
                .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.openGroups[g.bucket] = !open; cx.notify(); })
                .child(div().w(10).child(open ? "▾" : "▸")).child(div().child(`${g.label.toUpperCase()} ${count(g.bucket)}`)),
              ...(open ? this.checks.filter((c) => c.bucket === g.bucket).map((c) => this.checkRow(c, t)) : []),
            ];
          })))
        .child(Scrollbar.vertical("ci-list").absolute().inset_0()))
      .child(h_flex().flex_none().h(28).px(12).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().truncate().child(this.repo ? this.repo.split("/").pop() : ""))
        .when(Boolean(this.at), (e) => e.child(div().child(`checked ${new Date(this.at).toTimeString().slice(0, 8)} · every ${this.pending ? 10 : 60}s`))));
  }
}
