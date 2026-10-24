export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });

export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel)!;

/** Builds an element with text content only. Never sets innerHTML from data. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string | null>
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

export interface Fund {
  inCents: number;
  outCents: number;
  pendingCents: number;
  availableCents: number;
  donations: number;
  grantsPaid: number;
  requestsWaiting: number;
  avgHoursToGrant: number | null;
}

export async function renderFund(): Promise<Fund | null> {
  const { ok, data } = await api<Fund>("/api/fund");
  if (!ok) return null;
  const total = Math.max(1, data.inCents);
  const pct = (c: number) => `${Math.max(0, Math.min(100, (c / total) * 100))}%`;
  const set = (id: string, text: string) => {
    const n = document.getElementById(id);
    if (n) n.textContent = text;
  };
  set("fund-in", money(data.inCents));
  set("fund-out", money(data.outCents));
  set("fund-pending", money(data.pendingCents));
  set("fund-avail", money(Math.max(0, data.availableCents)));
  const w = (id: string, c: number) => {
    const n = document.getElementById(id);
    if (n) n.style.width = pct(c);
  };
  w("bar-out", data.outCents);
  w("bar-pending", data.pendingCents);
  w("bar-avail", Math.max(0, data.availableCents));
  return data;
}
