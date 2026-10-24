import type { Db } from "./db/index.js";

/** Payout statuses that mean the money has left, or is committed to leave, the fund. */
export const COMMITTED_PAYOUT = [
  "creating",
  "pending",
  "processing",
  "succeeded",
  "unclaimed",
  "held",
];

export interface FundHealth {
  inCents: number;
  outCents: number;
  pendingCents: number;
  availableCents: number;
  donations: number;
  grantsPaid: number;
  requestsWaiting: number;
  avgHoursToGrant: number | null;
}

export async function fundHealth(db: Db): Promise<FundHealth> {
  const [r] = await db.query<{
    in_cents: number;
    out_cents: number;
    pending_cents: number;
    donations: number;
    grants_paid: number;
    waiting: number;
    avg_hours: number | null;
  }>(
    `select
       (select coalesce(sum(amount_cents), 0)::int from donations where status = 'captured') as in_cents,
       (select coalesce(sum(amount_cents), 0)::int from payouts where status in ('succeeded', 'unclaimed')) as out_cents,
       (select coalesce(sum(amount_cents), 0)::int from payouts where status in ('creating', 'pending', 'processing', 'held')) as pending_cents,
       (select count(*)::int from donations where status = 'captured') as donations,
       (select count(*)::int from payouts where status = 'succeeded') as grants_paid,
       (select count(*)::int from requests where status in ('submitted', 'needs_info', 'blocked')) as waiting,
       (select (avg(extract(epoch from (p.updated_at - r.created_at))) / 3600)::float8
          from payouts p join requests r on r.id = p.request_id where p.status = 'succeeded') as avg_hours`,
  );
  const h = r!;
  return {
    inCents: h.in_cents,
    outCents: h.out_cents,
    pendingCents: h.pending_cents,
    availableCents: h.in_cents - h.out_cents - h.pending_cents,
    donations: h.donations,
    grantsPaid: h.grants_paid,
    requestsWaiting: h.waiting,
    avgHoursToGrant: h.avg_hours === null ? null : Math.round(h.avg_hours * 10) / 10,
  };
}

export async function availableCents(db: Db): Promise<number> {
  return (await fundHealth(db)).availableCents;
}
