import { $, api, el } from "./common.js";

const LABEL: Record<string, string> = {
  submitted: "Received. A volunteer will review it soon.",
  blocked: "Received. A volunteer will review it soon.",
  needs_info: "A volunteer needs more information. They'll reach out.",
  approved: "Approved. The grant is being prepared.",
  paying: "Approved. PayPal is sending the grant.",
  paid: "Paid. Check your PayPal account.",
  declined: "This request wasn't approved.",
  failed: "Approved, but PayPal couldn't deliver the grant. A volunteer will follow up.",
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
