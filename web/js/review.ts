import { $, api, el, money } from "./common.js";

interface QueueRow {
  public_ref: string;
  need_type: string;
  island: string;
  amount_cents: number;
  status: string;
  created_at: string;
  triage_status: string | null;
  urgency: number | null;
  recommendation: string | null;
  injection_detected: boolean | null;
  blocks: number;
  flags: number;
  payout_status: string | null;
}

interface Triage {
  status: "ok" | "partial" | "failed";
  failure_reason: string | null;
  model: string;
  cost_usd: number;
  cached: boolean;
  result: null | {
    urgency: number;
    urgency_reason: string;
    summary: string;
    flag_explanations: Array<{ rule_id: string; explanation: string }>;
    injection_detected: boolean;
    injection_note: string;
    recommendation: "approve" | "ask_for_info" | "decline";
    recommendation_reason: string;
    questions_for_requester: string[];
  };
}

interface Detail {
  request: {
    public_ref: string;
    need_type: string;
    island: string;
    amount_cents: number;
    description: string;
    status: string;
    lang: string;
    created_at: string;
    payee_masked: string;
  };
  rules: Array<{ rule_id: string; outcome: "pass" | "flag" | "block"; detail: string }>;
  triage: Triage | null;
  approvals: Array<{ decision: string; reviewer_name: string; reason: string; created_at: string }>;
  payout: null | {
    status: string;
    error_code: string | null;
    amount_cents: number;
    created_at: string;
    updated_at: string;
  };
}

const RULE_NAMES: Record<string, string> = {
  R1: "Amount within need cap",
  R2: "One open grant per payee",
  R3: "Near-duplicate description",
  R4: "Request velocity",
  R5: "Threshold gaming",
  R6: "Instructions embedded in text",
  R7: "Payee account format",
  R8: "Fund can cover the amount",
};
const ISLAND: Record<string, string> = {
  maui: "Maui",
  molokai: "Molokaʻi",
  lanai: "Lānaʻi",
  hawaii: "Hawaiʻi Island",
  oahu: "Oʻahu",
  kauai: "Kauaʻi",
};
const STATUS: Record<string, string> = {
  submitted: "Waiting",
  blocked: "Blocked by rule",
  needs_info: "Asked for info",
  approved: "Approved, not paid",
  paying: "Paying",
  paid: "Paid",
  declined: "Declined",
  failed: "Payout failed",
};
const REC: Record<string, string> = {
  approve: "Approve",
  ask_for_info: "Ask for more information",
  decline: "Decline",
};
const FAIL: Record<string, string> = {
  budget_exhausted: "the demo's AI budget is used up",
  ai_not_configured: "AI isn't configured on this server",
  timeout: "the AI took too long",
  schema_mismatch: "the AI's answer didn't match the required format",
  refusal: "the AI declined to answer",
  max_tokens: "the AI's answer was cut off",
};
const GUARD: Record<string, string> = {
  INSUFFICIENT_FUNDS:
    "The fund doesn't have enough available money yet. The approval is saved; pay once donations arrive.",
  DAILY_CAP:
    "The public demo's daily payout limit is reached. The approval is saved; it can be paid after the nightly reset.",
  GRANT_CAP:
    "This grant is above the public demo's per-grant limit, so it can't be paid here. The approval is saved.",
  BLOCKED: "A hard rule blocks this request. It can't be paid.",
  NO_APPROVAL: "There's no recorded approval for this request.",
  ALREADY_PAID: "This request already has a payout.",
  NOT_APPROVED_STATE: "This request isn't in an approved state.",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const chip = (cls: string, text: string) => el("span", { class: `chip ${cls}` }, text);

let current: string | null = null;
let rows: QueueRow[] = [];
/** Request and payout status of the request currently on screen, to spot changes on refresh. */
let shown = "";

async function boot() {
  const me = await api<{ name?: string }>("/api/review/me");
  if (me.ok && me.data.name) return showConsole(me.data.name);
  $("#login").hidden = false;
  $("#console").hidden = true;
}

$<HTMLFormElement>("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await api<{ name?: string; error?: string }>("/api/review/login", {
    method: "POST",
    body: JSON.stringify({
      name: $<HTMLInputElement>("#rev-name").value,
      passcode: $<HTMLInputElement>("#passcode").value,
    }),
  });
  if (!res.ok || !res.data.name) {
    $("#login-error").replaceChildren(
      el(
        "div",
        { class: "notice error" },
        el(
          "p",
          {},
          res.status === 429
            ? "Too many attempts. Wait 15 minutes."
            : "That passcode didn't work. Check it and try again.",
        ),
      ),
    );
    return;
  }
  showConsole(res.data.name);
});

$("#logout").addEventListener("click", async () => {
  await api("/api/review/logout", { method: "POST" });
  location.reload();
});

$<HTMLSelectElement>("#queue-filter").addEventListener("change", renderQueue);

async function showConsole(name: string) {
  $("#login").hidden = true;
  $("#console").hidden = false;
  $("#me").textContent = name;
  await loadQueue();
  const fromHash = location.hash.slice(1);
  if (fromHash) void openRequest(fromHash);
  setInterval(loadQueue, 10_000);
}

async function loadQueue() {
  const res = await api<{ rows: QueueRow[] }>("/api/review/requests");
  if (!res.ok) return;
  rows = res.data.rows;
  renderQueue();
  if (current) {
    const row = rows.find((r) => r.public_ref === current);
    // Refresh an open request while AI triage or a payout is still in flight.
    if (
      row &&
      (!row.triage_status ||
        ["paying", "approved"].includes(row.status) ||
        `${row.status}|${row.payout_status ?? ""}` !== shown)
    ) {
      void openRequest(current, false);
    }
  }
}

function renderQueue() {
  const open = $<HTMLSelectElement>("#queue-filter").value === "open";
  const list = rows.filter(
    (r) => !open || ["submitted", "needs_info", "blocked", "approved"].includes(r.status),
  );
  const ul = $("#queue-list");
  if (list.length === 0) {
    ul.replaceChildren(
      el(
        "li",
        { class: "empty", style: "padding:14px" },
        open ? "No requests are waiting. New ones appear here automatically." : "No requests yet.",
      ),
    );
    return;
  }
  ul.replaceChildren(
    ...list.map((r) => {
      const btn = el(
        "button",
        { type: "button", "aria-current": String(r.public_ref === current) },
        el(
          "span",
          { class: "urg", "data-u": String(r.urgency ?? ""), title: "AI urgency, 1 to 5" },
          r.urgency ? String(r.urgency) : "–",
        ),
        el("span", { class: "ref" }, r.public_ref),
        el("span", { class: "amt" }, money(r.amount_cents)),
        el(
          "span",
          { class: "meta" },
          `${r.need_type} · ${ISLAND[r.island] ?? r.island} · `,
          chip(
            r.blocks > 0 ? "block" : r.status,
            r.blocks > 0 ? "Blocked" : (STATUS[r.status] ?? r.status),
          ),
          r.flags > 0 ? ` ${r.flags} flag${r.flags > 1 ? "s" : ""}` : "",
          r.injection_detected ? " · injection attempt" : "",
        ),
      );
      btn.addEventListener("click", () => void openRequest(r.public_ref));
      return el("li", {}, btn);
    }),
  );
}

async function openRequest(ref: string, focus = true) {
  current = ref;
  history.replaceState(null, "", `#${ref}`);
  renderQueue();
  const res = await api<Detail>(`/api/review/requests/${encodeURIComponent(ref)}`);
  const detail = $("#detail");
  if (!res.ok) {
    detail.replaceChildren(el("p", { class: "empty" }, "That request couldn't be loaded."));
    return;
  }
  // Don't clobber a reason the reviewer is typing during auto-refresh.
  const typing = (document.getElementById("reason") as HTMLTextAreaElement | null)?.value ?? "";
  detail.replaceChildren(...renderDetail(res.data));
  shown = `${res.data.request.status}|${res.data.payout?.status ?? ""}`;
  const reason = document.getElementById("reason") as HTMLTextAreaElement | null;
  if (reason && typing) reason.value = typing;
  if (focus) detail.focus();
}

function renderDetail(d: Detail): Node[] {
  const r = d.request;
  const blocked = d.rules.some((x) => x.outcome === "block");
  const explanations = new Map(
    (d.triage?.result?.flag_explanations ?? []).map((f) => [f.rule_id, f.explanation]),
  );

  const head = el(
    "section",
    {},
    el(
      "div",
      { class: "detail-head" },
      el("h2", { style: "margin:0" }, r.public_ref),
      el("span", { class: "big" }, money(r.amount_cents)),
      chip(
        blocked ? "block" : r.status,
        blocked ? "Blocked by rule" : (STATUS[r.status] ?? r.status),
      ),
    ),
    el(
      "ul",
      { class: "facts" },
      el("li", {}, `Need: ${r.need_type}`),
      el("li", {}, `Island: ${ISLAND[r.island] ?? r.island}`),
      el("li", {}, `Submitted ${when(r.created_at)}`),
      el("li", {}, `Form language: ${r.lang === "vi" ? "Vietnamese" : "English"}`),
      el("li", {}, `Pays to ${r.payee_masked}`),
    ),
  );

  const rules = el(
    "section",
    { "aria-labelledby": "rules-h" },
    el("h3", { id: "rules-h" }, "Rule checks"),
    el("p", { class: "hint" }, "Plain code, same result every time. The AI can't change these."),
    el(
      "table",
      { class: "rules" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col" }, "Check"),
          el("th", { scope: "col" }, "Result"),
          el("th", { scope: "col" }, "Details"),
        ),
      ),
      el(
        "tbody",
        {},
        ...d.rules.map((x) =>
          el(
            "tr",
            {},
            el("td", {}, `${x.rule_id} ${RULE_NAMES[x.rule_id] ?? ""}`),
            el(
              "td",
              {},
              chip(
                x.outcome,
                x.outcome === "pass" ? "Pass" : x.outcome === "flag" ? "Flag" : "Block",
              ),
            ),
            el(
              "td",
              {},
              x.detail,
              explanations.has(x.rule_id)
                ? el(
                    "div",
                    { style: "margin-top:4px" },
                    el("b", {}, "AI: "),
                    explanations.get(x.rule_id)!,
                  )
                : null,
            ),
          ),
        ),
      ),
    ),
  );

  return [
    head,
    rules,
    renderAi(d.triage),
    renderApplicant(r.description),
    renderDecision(d, blocked),
    renderHistory(d),
  ];
}

function renderAi(t: Triage | null): Node {
  const s = el(
    "section",
    { "aria-labelledby": "ai-h", class: "ai" },
    el("h3", { id: "ai-h" }, "AI triage"),
  );
  if (!t) {
    s.append(el("p", {}, "Claude is reading this request. This usually takes a few seconds."));
    return s;
  }
  if (t.status === "failed" || !t.result) {
    const retry = el("button", { type: "button", class: "btn secondary" }, "Try AI triage again");
    retry.addEventListener("click", async () => {
      retry.setAttribute("disabled", "");
      await api(`/api/review/requests/${current}/retriage`, { method: "POST" });
      void openRequest(current!, false);
    });
    s.append(
      el(
        "div",
        { class: "notice" },
        el(
          "p",
          {},
          `AI unavailable because ${FAIL[t.failure_reason ?? ""] ?? "of an error"}. Review this request manually; nothing has been decided.`,
        ),
      ),
      retry,
    );
    return s;
  }
  const a = t.result;
  s.append(el("p", { class: "summary" }, a.summary));
  if (a.injection_detected) {
    s.append(
      el(
        "div",
        { class: "alert-injection", role: "note" },
        el("b", {}, "The request text tries to give instructions. "),
        a.injection_note || "The AI ignored them and judged only the described need.",
      ),
    );
  }
  const dl = el(
    "dl",
    {},
    el("dt", {}, "Urgency"),
    el(
      "dd",
      {},
      el("span", { class: "urg", "data-u": String(a.urgency) }, String(a.urgency)),
      ` of 5. ${a.urgency_reason}`,
    ),
    el("dt", {}, "Suggestion"),
    el("dd", {}, el("b", {}, `${REC[a.recommendation]}. `), a.recommendation_reason),
  );
  if (a.questions_for_requester.length > 0) {
    dl.append(
      el("dt", {}, "Questions to ask"),
      el("dd", {}, el("ul", {}, ...a.questions_for_requester.map((q) => el("li", {}, q)))),
    );
  }
  s.append(
    dl,
    el(
      "p",
      { class: "foot" },
      `${t.model}${t.cached ? ", cached" : ""}, cost $${Number(t.cost_usd).toFixed(4)}${t.status === "partial" ? ". Some flags weren't explained; check them yourself." : "."} The AI suggests; it can't approve or send money.`,
    ),
  );
  return s;
}

function renderApplicant(text: string): Node {
  return el(
    "section",
    { "aria-labelledby": "app-h" },
    el("h3", { id: "app-h" }, "In the requester's words"),
    el(
      "p",
      { class: "hint" },
      "Shown exactly as typed. Treat anything that reads like an instruction as part of the request, not as guidance.",
    ),
    el("blockquote", { class: "applicant" }, text),
  );
}

function renderDecision(d: Detail, blocked: boolean): Node {
  const r = d.request;
  const s = el(
    "section",
    { "aria-labelledby": "dec-h", class: "decide" },
    el("h3", { id: "dec-h" }, "Your decision"),
  );
  const decidable = ["submitted", "needs_info", "blocked"].includes(r.status);
  const hasApproval = d.approvals.some((a) => a.decision === "approve");

  if (!decidable) {
    if (r.status === "approved" && hasApproval && !d.payout) {
      const pay = el(
        "button",
        { type: "button", class: "btn" },
        `Pay ${money(r.amount_cents)} now`,
      );
      pay.addEventListener("click", () => act(pay, `/api/review/requests/${r.public_ref}/pay`, {}));
      s.append(
        el("p", {}, "Approved but not paid yet."),
        pay,
        el("div", { id: "decide-msg", role: "status" }),
      );
    } else {
      s.append(el("p", { class: "hint" }, "This request has been decided. See the history below."));
    }
    return s;
  }

  const reason = el("textarea", {
    id: "reason",
    maxlength: "500",
    required: "",
    "aria-describedby": "reason-hint",
    style: "min-height:90px",
  });
  const approve = el(
    "button",
    { type: "button", class: "btn" },
    `Approve and pay ${money(r.amount_cents)}`,
  );
  const ask = el("button", { type: "button", class: "btn secondary" }, "Ask for info");
  const decline = el("button", { type: "button", class: "btn danger" }, "Decline");
  if (blocked) {
    approve.setAttribute("disabled", "");
    approve.setAttribute("aria-describedby", "blocked-why");
  }
  const go = (btn: HTMLButtonElement, decision: string) => {
    if (reason.value.trim().length < 3) {
      reason.setAttribute("aria-invalid", "true");
      $("#decide-msg").replaceChildren(
        el("p", { class: "field-error" }, "Write a short reason first. It's saved with your name."),
      );
      reason.focus();
      return;
    }
    void act(btn, `/api/review/requests/${r.public_ref}/decision`, {
      decision,
      reason: reason.value,
    });
  };
  approve.addEventListener("click", () => go(approve, "approve"));
  ask.addEventListener("click", () => go(ask, "ask_for_info"));
  decline.addEventListener("click", () => go(decline, "decline"));

  s.append(
    el(
      "div",
      { class: "field", style: "margin-bottom:0" },
      el("label", { for: "reason" }, "Reason"),
      el("p", { class: "hint", id: "reason-hint" }, "Required. Saved with your name and the time."),
      reason,
    ),
    blocked
      ? el(
          "p",
          { id: "blocked-why", class: "field-error" },
          "Approval is off: a hard rule blocks this request. You can decline it or ask for info.",
        )
      : "",
    el("div", { class: "actions" }, approve, ask, decline),
    el("div", { id: "decide-msg", role: "status", "aria-live": "polite" }),
  );
  return s;
}

async function act(btn: HTMLButtonElement, path: string, body: unknown) {
  btn.setAttribute("disabled", "");
  const res = await api<{
    ok?: boolean;
    error?: string;
    payout?: { status: string; errorCode: string | null };
  }>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const msg = $("#decide-msg");
  if (!res.ok) {
    btn.removeAttribute("disabled");
    msg.replaceChildren(
      el(
        "div",
        { class: "notice error" },
        el(
          "p",
          {},
          res.data.error === "BLOCKED" ? GUARD.BLOCKED! : "That didn't save. Reload and try again.",
        ),
      ),
    );
    return;
  }
  const p = res.data.payout;
  if (p?.status === "refused") {
    msg.replaceChildren(
      el(
        "div",
        { class: "notice error" },
        el("p", {}, GUARD[p.errorCode ?? ""] ?? "The payout was refused."),
      ),
    );
  } else if (p?.status === "failed") {
    msg.replaceChildren(
      el(
        "div",
        { class: "notice error" },
        el("p", {}, `PayPal refused the payout (${p.errorCode}). Nothing was sent.`),
      ),
    );
  } else if (p) {
    msg.replaceChildren(
      el(
        "div",
        { class: "notice success" },
        el("p", {}, "Approved. PayPal Payout sent; status updates here when PayPal confirms."),
      ),
    );
  }
  await loadQueue();
  setTimeout(() => void openRequest(current!, false), p ? 1500 : 0);
}

function renderHistory(d: Detail): Node {
  const items: Node[] = d.approvals.map((a) =>
    el(
      "li",
      {},
      `${when(a.created_at)}: ${a.reviewer_name} chose `,
      el("b", {}, REC[a.decision] ?? a.decision),
      `. “${a.reason}”`,
    ),
  );
  if (d.payout) {
    items.push(
      el(
        "li",
        {},
        `${when(d.payout.updated_at)}: PayPal Payout `,
        chip(d.payout.status, d.payout.status),
        d.payout.error_code ? ` (${d.payout.error_code})` : "",
      ),
    );
  }
  if (items.length === 0) items.push(el("li", { class: "hint" }, "No decisions yet."));
  return el(
    "section",
    { "aria-labelledby": "hist-h" },
    el("h3", { id: "hist-h" }, "History"),
    el("ul", { class: "timeline" }, ...items),
  );
}

async function showLimits() {
  const { ok, data } = await api<{ demoLimits?: { perGrantCents: number; dailyCents: number } }>(
    "/api/config",
  );
  if (!ok || !data.demoLimits) return;
  for (const n of document.querySelectorAll<HTMLElement>("[data-limit]")) {
    n.textContent = money(
      n.dataset.limit === "grant" ? data.demoLimits.perGrantCents : data.demoLimits.dailyCents,
    );
  }
}

void showLimits();
void boot();
