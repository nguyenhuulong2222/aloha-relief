import { $, api, el } from "./common.js";

const LABEL: Record<string, string> = {
  in_review:
    "Received. A volunteer is reviewing it. If they need more information, they'll reach out.",
  approved: "Approved. PayPal is sending the grant.",
  paid: "Paid. Check your PayPal account.",
  closed: "This request is closed and wasn't approved.",
};

const input = $<HTMLInputElement>("#ref");
async function check(ref: string) {
  const out = $("#status-out");
  const res = await api<{ status?: string }>(
    `/api/requests/${encodeURIComponent(ref.trim().toUpperCase())}/status`,
  );
  out.replaceChildren(
    el(
      "div",
      { class: `notice ${res.ok ? "" : "error"}` },
      el(
        "p",
        {},
        res.ok && res.data.status
          ? `${ref.toUpperCase()}: ${LABEL[res.data.status] ?? res.data.status}`
          : "We couldn't find that request number. Check it and try again.",
      ),
    ),
  );
}
$<HTMLFormElement>("#status-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void check(input.value);
});
if (location.hash.length > 1) {
  input.value = decodeURIComponent(location.hash.slice(1));
  void check(input.value);
}
