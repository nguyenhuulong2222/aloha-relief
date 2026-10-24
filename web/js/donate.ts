/**
 * PayPal JS SDK v6 one-time payment.
 * https://developer.paypal.com/docsai/payments/methods/paypal/sdk/js/v6/paypal-checkout (updated 2026-10-13)
 * The server sets the amount and captures; the browser only starts the session.
 */
import { $, api, el } from "./common.js";

const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

interface PayPalSession {
  start(opts: { presentationMode: "auto" }, order: Promise<{ orderId: string }>): Promise<void>;
}
interface PayPalSdk {
  createInstance(o: { clientId: string; components: string[]; pageType?: string }): Promise<{
    findEligibleMethods(o: { currencyCode: string }): Promise<{ isEligible(m: string): boolean }>;
    createPayPalOneTimePaymentSession(o: {
      onApprove(d: { orderId: string }): Promise<void>;
      onCancel(d: unknown): void;
      onError(e: Error): void;
    }): PayPalSession;
  }>;
}
declare global {
  interface Window {
    paypal?: PayPalSdk;
  }
}

const status = $("#donate-status");

function show(kind: "success" | "error" | "info", ...content: Array<Node | string>) {
  status.replaceChildren(
    el("div", { class: `notice ${kind === "info" ? "" : kind}` }, el("p", {}, ...content)),
  );
}

function selectedCents(): number | null {
  const v = document.querySelector<HTMLInputElement>('input[name="amount"]:checked')?.value;
  if (v === "other") {
    const d = Number($<HTMLInputElement>("#other-amount").value);
    if (!Number.isFinite(d) || d < 1 || d > 500) return null;
    return Math.round(d * 100);
  }
  return v ? Number(v) : null;
}

for (const r of document.querySelectorAll<HTMLInputElement>('input[name="amount"]')) {
  r.addEventListener("change", () => {
    $("#other-wrap").hidden = r.value !== "other" || !r.checked;
  });
}

function loadSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("sdk_load_failed"));
    document.head.append(s);
  });
}

async function createOrder(): Promise<{ orderId: string }> {
  const cents = selectedCents();
  if (!cents) throw new Error("Choose an amount between $1 and $500.");
  const { ok, data } = await api<{ orderId?: string; error?: string }>("/api/donations", {
    method: "POST",
    body: JSON.stringify({ amountCents: cents }),
  });
  if (!ok || !data.orderId)
    throw new Error(
      data.error === "rate_limited"
        ? "Too many tries. Wait a few minutes."
        : "Couldn't start the donation.",
    );
  return { orderId: data.orderId };
}

async function init() {
  const { data: cfg } = await api<{ paypalClientId: string }>("/api/config");
  await loadSdk();
  const sdk = await window.paypal!.createInstance({
    clientId: cfg.paypalClientId,
    components: ["paypal-payments"],
    pageType: "checkout",
  });
  const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
  $("#sdk-loading").remove();
  if (!methods.isEligible("paypal")) {
    show("error", "PayPal isn't available in this browser right now. Try another browser.");
    return;
  }
  const session = sdk.createPayPalOneTimePaymentSession({
    async onApprove({ orderId }) {
      show("info", "Confirming your gift with PayPal…");
      const { ok, data } = await api<{ ref?: string; status?: string }>(
        `/api/donations/${orderId}/capture`,
        { method: "POST" },
      );
      if (ok && data.status === "captured") {
        show(
          "success",
          el("strong", {}, `Mahalo. Gift ${data.ref} is in the fund. `),
          "See it on the ",
          el("a", { href: `/ledger#${data.ref}` }, "public ledger"),
          ".",
        );
      } else if (ok && data.status === "pending") {
        show(
          "info",
          `Gift ${data.ref} is pending at PayPal. The ledger will update when it clears.`,
        );
      } else {
        show("error", "PayPal didn't confirm the payment. You haven't been charged. Try again.");
      }
    },
    onCancel() {
      show("info", "Donation cancelled. Nothing was charged.");
    },
    onError(err) {
      show("error", err.message || "Something went wrong with PayPal. Try again.");
    },
  });
  const button = $("#paypal-button");
  button.hidden = false;
  button.addEventListener("click", async () => {
    if (!selectedCents()) {
      show("error", "Choose an amount between $1 and $500.");
      $<HTMLInputElement>("#other-amount").focus();
      return;
    }
    status.replaceChildren();
    try {
      // Don't await createOrder before start(): PayPal needs the click's transient activation.
      await session.start({ presentationMode: "auto" }, createOrder());
    } catch (e) {
      show("error", (e as Error).message);
    }
  });
}

init().catch(() => {
  $("#sdk-loading").textContent = "";
  show("error", "PayPal couldn't load. Check your connection and reload the page.");
});
