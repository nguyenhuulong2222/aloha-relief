/**
 * Account balance of the fund's sandbox business account.
 * Transaction Search API v1: GET /v1/reporting/balances
 * https://developer.paypal.com/docs/api/transaction-search/v1/  (scope .../reporting/balances/read,
 * granted when "Transaction search" is enabled on the REST app)
 */
import type { PayPalClient } from "./client.js";
import { valueToCents } from "./orders.js";

interface BalancesResponse {
  balances?: Array<{
    currency: string;
    available_balance?: { value: string };
    total_balance?: { value: string };
  }>;
}

export async function availableBalanceCents(
  pp: PayPalClient,
  currency = "USD",
): Promise<number | null> {
  const res = await pp.request<BalancesResponse>(
    `/v1/reporting/balances?currency_code=${currency}`,
  );
  const b = res.balances?.find((x) => x.currency === currency);
  const v = b?.available_balance?.value ?? b?.total_balance?.value;
  return v === undefined ? null : valueToCents(v);
}
