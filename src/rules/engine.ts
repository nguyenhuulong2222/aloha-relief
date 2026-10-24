/**
 * Deterministic checks. Plain code, no AI. A BLOCK cannot be cleared by the AI or by a reviewer:
 * the reviewer can only decline a blocked request.
 */

export const NEED_TYPES = [
  "food",
  "shelter",
  "transport",
  "medical",
  "utilities",
  "other",
] as const;
export type NeedType = (typeof NEED_TYPES)[number];

export const ISLANDS = ["maui", "molokai", "lanai", "hawaii", "oahu", "kauai"] as const;
export type Island = (typeof ISLANDS)[number];

/** Per-need caps in cents. */
export const NEED_CAPS: Record<NeedType, number> = {
  food: 20_000,
  transport: 25_000,
  utilities: 30_000,
  medical: 40_000,
  shelter: 50_000,
  other: 15_000,
};

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8";
export type Outcome = "block" | "flag" | "pass";

export interface RuleResult {
  ruleId: RuleId;
  outcome: Outcome;
  /** Short, PII-free, machine-generated explanation of what was checked. */
  detail: string;
}

export const RULE_NAMES: Record<RuleId, string> = {
  R1: "Amount within need cap",
  R2: "One open grant per payee",
  R3: "Near-duplicate description",
  R4: "Request velocity",
  R5: "Threshold gaming",
  R6: "Instructions embedded in text",
  R7: "Payee account format",
  R8: "Fund can cover the amount",
};

export interface NewRequest {
  needType: NeedType;
  amountCents: number;
  description: string;
  payeeEmail: string;
  payeeHash: string;
  clientHash: string;
  now: Date;
}

export interface HistoryItem {
  publicRef: string;
  payeeHash: string;
  clientHash: string;
  description: string;
  amountCents: number;
  status: string;
  createdAt: Date;
}

export interface RuleContext {
  /** Requests from the last 30 days, excluding the one being checked. */
  history: HistoryItem[];
  /** Captured donations minus committed payouts, in cents. */
  availableCents: number;
}

const DAY = 24 * 60 * 60 * 1000;
const OPEN_OR_PAID = new Set(["submitted", "needs_info", "approved", "paying", "paid", "blocked"]);

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "trashmail.com",
  "sharklasers.com",
  "getnada.com",
  "dispostable.com",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Patterns that read as instructions to an AI or reviewer rather than a description of need. */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [
    /\bignore\b.{0,40}\b(previous|prior|above|all|your)\b.{0,20}\b(instruction|rule|prompt)s?/i,
    "ignore-instructions phrase",
  ],
  [/\b(system|assistant|developer)\s*(prompt|message)?\s*:/i, "role label"],
  [/<\/?\s*(system|assistant|instructions?|request_data)\b/i, "markup tag"],
  [/\byou are (now )?(an?|the) /i, "role reassignment"],
  [
    /\b(mark|set|flag)\b.{0,30}\b(approved|urgent|urgency\s*5|legit(imate)?)\b/i,
    "outcome instruction",
  ],
  [
    /\b(approve|auto-?approve)\b.{0,20}\b(this|me|request|immediately|now)\b/i,
    "approval instruction",
  ],
  [/\bdisregard\b|\boverride\b.{0,20}\b(rules?|checks?|policy)\b/i, "override phrase"],
  [/https?:\/\/|www\./i, "link"],
  [/[A-Za-z0-9+/]{60,}={0,2}/, "long encoded string"],
];

export function normalizeEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  // Collapse plus-addressing so "a+1@x" and "a+2@x" count as the same payee.
  return `${local.split("+")[0]}@${domain}`;
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const t = ` ${normalizeText(s)} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Jaccard similarity of character trigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export function findInjectionMarkers(text: string): string[] {
  return INJECTION_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

export function evaluateRules(req: NewRequest, ctx: RuleContext): RuleResult[] {
  const now = req.now.getTime();
  const recent = ctx.history.filter((h) => now - h.createdAt.getTime() <= 30 * DAY);
  const results: RuleResult[] = [];
  const cap = NEED_CAPS[req.needType];

  // R1: amount cap
  if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) {
    results.push({
      ruleId: "R1",
      outcome: "block",
      detail: "Amount must be a positive whole number of cents.",
    });
  } else if (req.amountCents > cap) {
    results.push({
      ruleId: "R1",
      outcome: "block",
      detail: `${dollars(req.amountCents)} exceeds the ${req.needType} cap of ${dollars(cap)}.`,
    });
  } else {
    results.push({
      ruleId: "R1",
      outcome: "pass",
      detail: `Within the ${req.needType} cap of ${dollars(cap)}.`,
    });
  }

  // R2: same payee already has an open or paid request in 30 days
  const samePayee = recent.filter(
    (h) => h.payeeHash === req.payeeHash && OPEN_OR_PAID.has(h.status),
  );
  if (samePayee.length > 0) {
    results.push({
      ruleId: "R2",
      outcome: "block",
      detail: `Same payee account already has ${samePayee.map((h) => h.publicRef).join(", ")} in the last 30 days.`,
    });
  } else {
    results.push({
      ruleId: "R2",
      outcome: "pass",
      detail: "No other open or paid request for this payee in 30 days.",
    });
  }

  // R3: near-duplicate description from anyone
  let best: { ref: string; score: number } | null = null;
  for (const h of recent) {
    const score = similarity(req.description, h.description);
    if (!best || score > best.score) best = { ref: h.publicRef, score };
  }
  if (best && best.score >= 0.8) {
    results.push({
      ruleId: "R3",
      outcome: "flag",
      detail: `Description is ${Math.round(best.score * 100)}% similar to ${best.ref}.`,
    });
  } else {
    results.push({
      ruleId: "R3",
      outcome: "pass",
      detail: "No near-duplicate description in 30 days.",
    });
  }

  // R4: velocity
  const sameClient24h = recent.filter(
    (h) => h.clientHash === req.clientHash && now - h.createdAt.getTime() <= DAY,
  );
  const fundLastHour = recent.filter((h) => now - h.createdAt.getTime() <= 60 * 60 * 1000);
  if (sameClient24h.length >= 2) {
    results.push({
      ruleId: "R4",
      outcome: "flag",
      detail: `${sameClient24h.length + 1} requests from the same device in 24 hours.`,
    });
  } else if (fundLastHour.length >= 20) {
    results.push({
      ruleId: "R4",
      outcome: "flag",
      detail: `${fundLastHour.length + 1} requests fund-wide in the last hour.`,
    });
  } else {
    results.push({ ruleId: "R4", outcome: "pass", detail: "Normal request rate." });
  }

  // R5: threshold gaming: just under the cap, or the same odd amount across different payees
  const nearCap = req.amountCents <= cap && req.amountCents >= Math.floor(cap * 0.97);
  const oddAmount = req.amountCents % 500 !== 0;
  const sameOddAmount =
    oddAmount &&
    recent.filter((h) => h.amountCents === req.amountCents && h.payeeHash !== req.payeeHash)
      .length >= 2;
  if (nearCap || sameOddAmount) {
    results.push({
      ruleId: "R5",
      outcome: "flag",
      detail: nearCap
        ? `${dollars(req.amountCents)} sits just under the ${dollars(cap)} cap.`
        : `${dollars(req.amountCents)} matches 2+ requests from other payees.`,
    });
  } else {
    results.push({ ruleId: "R5", outcome: "pass", detail: "No cap-edge or repeated odd amount." });
  }

  // R6: injection markers (the text still goes to the AI, strictly as data)
  const markers = findInjectionMarkers(req.description);
  if (markers.length > 0) {
    results.push({
      ruleId: "R6",
      outcome: "flag",
      detail: `Text contains: ${markers.join(", ")}.`,
    });
  } else {
    results.push({ ruleId: "R6", outcome: "pass", detail: "No instruction-like text found." });
  }

  // R7: payee format
  const email = req.payeeEmail.trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    results.push({ ruleId: "R7", outcome: "block", detail: "Payee is not a valid email address." });
  } else if (DISPOSABLE_DOMAINS.has(domain)) {
    results.push({
      ruleId: "R7",
      outcome: "flag",
      detail: "Payee uses a disposable email domain.",
    });
  } else {
    results.push({ ruleId: "R7", outcome: "pass", detail: "Payee email format is valid." });
  }

  // R8: fund balance
  if (req.amountCents > ctx.availableCents) {
    results.push({
      ruleId: "R8",
      outcome: "flag",
      detail: `Fund has ${dollars(Math.max(0, ctx.availableCents))} available; hold until funded.`,
    });
  } else {
    results.push({ ruleId: "R8", outcome: "pass", detail: "Fund can cover this amount." });
  }

  return results;
}

export const isBlocked = (rs: Pick<RuleResult, "outcome">[]) =>
  rs.some((r) => r.outcome === "block");
