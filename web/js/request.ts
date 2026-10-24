import { $, api, el } from "./common.js";

type Lang = "en" | "vi";

const T: Record<Lang, Record<string, string>> = {
  en: {
    title: "Ask for help",
    intro:
      "Tell us what you need. A volunteer reads every request, usually within a day. If it's approved, the grant goes straight to your PayPal account. Only volunteers see your description and email; the public ledger shows only the type of need, island and amount.",
    need: "What do you need help with?",
    need_food: "Food",
    need_shelter: "Shelter",
    need_transport: "Transport",
    need_medical: "Medical",
    need_utilities: "Utilities",
    need_other: "Something else",
    island: "Island",
    island_pick: "Choose an island",
    amount: "Amount in US dollars",
    amount_hint:
      "Grants are small. Limits: food $200, transport $250, utilities $300, medical $400, shelter $500, other $150.",
    desc: "What happened, and what will this cover?",
    desc_hint:
      "A few sentences is enough. Please don't include anyone's full name, address or medical details.",
    payee: "PayPal email for the grant",
    payee_hint: "We send the money here with PayPal. In this demo, use a PayPal sandbox email.",
    consent:
      "I understand this is a demo with sandbox money, and that a volunteer will review my request.",
    submit: "Send request",
    chars: "{n} of 1000 characters",
    err_need: "Choose what you need help with.",
    err_island: "Choose an island.",
    err_amount: "Enter an amount of at least $1.",
    err_desc: "Write at least 10 characters about what you need.",
    err_payee: "Enter the email address of your PayPal account.",
    err_consent: "Check the box to continue.",
    err_server: "We couldn't send your request. Check your connection and try again.",
    err_rate: "You've sent several requests recently. Try again in an hour.",
    done_title: "Request {ref} received",
    done_body:
      "A volunteer will review it. If they need more information, they'll reach out. Keep this number; you can use it to check the status.",
    done_status: "Check status",
  },
  vi: {
    title: "Xin hỗ trợ",
    intro:
      "Hãy cho chúng tôi biết bạn cần gì. Tình nguyện viên đọc từng yêu cầu, thường trong vòng một ngày. Nếu được duyệt, tiền hỗ trợ sẽ chuyển thẳng vào tài khoản PayPal của bạn. Chỉ tình nguyện viên thấy mô tả và email của bạn; sổ công khai chỉ hiện loại nhu cầu, đảo và số tiền.",
    need: "Bạn cần hỗ trợ việc gì?",
    need_food: "Thực phẩm",
    need_shelter: "Chỗ ở",
    need_transport: "Đi lại",
    need_medical: "Y tế",
    need_utilities: "Điện nước",
    need_other: "Việc khác",
    island: "Đảo",
    island_pick: "Chọn đảo",
    amount: "Số tiền (đô la Mỹ)",
    amount_hint:
      "Các khoản hỗ trợ đều nhỏ. Giới hạn: thực phẩm $200, đi lại $250, điện nước $300, y tế $400, chỗ ở $500, việc khác $150.",
    desc: "Chuyện gì đã xảy ra, và khoản tiền này dùng vào việc gì?",
    desc_hint: "Vài câu là đủ. Xin đừng ghi họ tên đầy đủ, địa chỉ hay chi tiết bệnh án của ai.",
    payee: "Email PayPal để nhận tiền",
    payee_hint:
      "Chúng tôi gửi tiền qua PayPal tới email này. Trong bản demo, hãy dùng email PayPal sandbox.",
    consent:
      "Tôi hiểu đây là bản demo dùng tiền sandbox, và một tình nguyện viên sẽ xem xét yêu cầu của tôi.",
    submit: "Gửi yêu cầu",
    chars: "{n}/1000 ký tự",
    err_need: "Hãy chọn loại hỗ trợ bạn cần.",
    err_island: "Hãy chọn đảo.",
    err_amount: "Nhập số tiền từ $1 trở lên.",
    err_desc: "Viết ít nhất 10 ký tự về nhu cầu của bạn.",
    err_payee: "Nhập địa chỉ email tài khoản PayPal của bạn.",
    err_consent: "Đánh dấu vào ô để tiếp tục.",
    err_server: "Không gửi được yêu cầu. Kiểm tra kết nối mạng rồi thử lại.",
    err_rate: "Bạn đã gửi nhiều yêu cầu gần đây. Hãy thử lại sau một giờ.",
    done_title: "Đã nhận yêu cầu {ref}",
    done_body:
      "Tình nguyện viên sẽ xem xét. Nếu cần thêm thông tin, họ sẽ liên hệ. Hãy giữ mã số này để kiểm tra tình trạng.",
    done_status: "Xem tình trạng",
  },
};

let lang: Lang = "en";
const t = (k: string, vars: Record<string, string> = {}) =>
  (T[lang][k] ?? T.en[k] ?? k).replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? "");

const form = $<HTMLFormElement>("#request-form");
const desc = $<HTMLTextAreaElement>("#description");

function applyLang(next: Lang) {
  lang = next;
  $("#form-section").setAttribute("lang", lang);
  for (const n of document.querySelectorAll<HTMLElement>("[data-i18n]"))
    n.textContent = t(n.dataset.i18n!);
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
    b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  }
  updateCount();
}

function updateCount() {
  $("#desc-count").textContent = t("chars", { n: String(desc.value.length) });
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
  b.addEventListener("click", () => applyLang(b.dataset.lang as Lang));
}
desc.addEventListener("input", updateCount);

function clearErrors() {
  $("#form-errors").replaceChildren();
  for (const n of form.querySelectorAll(".field-error")) n.remove();
  for (const n of form.querySelectorAll("[aria-invalid]")) n.removeAttribute("aria-invalid");
}

function fieldError(input: HTMLElement, key: string) {
  input.setAttribute("aria-invalid", "true");
  const id = `${input.id || input.getAttribute("name")}-error`;
  const msg = el("p", { class: "field-error", id }, t(key));
  (input.closest(".field") ?? input.parentElement)!.append(msg);
  input.setAttribute(
    "aria-describedby",
    `${input.getAttribute("aria-describedby") ?? ""} ${id}`.trim(),
  );
  return key;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors();
  const fd = new FormData(form);
  const errors: string[] = [];
  const needType = fd.get("needType");
  const island = $<HTMLSelectElement>("#island");
  const amount = $<HTMLInputElement>("#amount");
  const payee = $<HTMLInputElement>("#payee");
  const consent = $<HTMLInputElement>("#consent");
  const firstNeed = form.querySelector<HTMLInputElement>('input[name="needType"]')!;
  if (!needType) errors.push(fieldError(firstNeed, "err_need"));
  if (!island.value) errors.push(fieldError(island, "err_island"));
  if (!(Number(amount.value) >= 1)) errors.push(fieldError(amount, "err_amount"));
  if (desc.value.trim().length < 10) errors.push(fieldError(desc, "err_desc"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payee.value.trim()))
    errors.push(fieldError(payee, "err_payee"));
  if (!consent.checked) errors.push(fieldError(consent, "err_consent"));
  if (errors.length > 0) {
    form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    return;
  }

  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submit.disabled = true;
  const { ok, status, data } = await api<{ ref?: string }>("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      needType,
      island: island.value,
      amountUsd: Number(amount.value),
      description: desc.value,
      payeeEmail: payee.value,
      lang,
      consent: true,
    }),
  });
  submit.disabled = false;
  if (!ok || !data.ref) {
    $("#form-errors").replaceChildren(
      el(
        "div",
        { class: "notice error" },
        el("p", {}, t(status === 429 ? "err_rate" : "err_server")),
      ),
    );
    return;
  }
  $("#form-section").hidden = true;
  const done = $("#request-done");
  done.setAttribute("lang", lang);
  done.replaceChildren(
    el(
      "div",
      { class: "notice success" },
      el("h2", {}, t("done_title", { ref: data.ref })),
      el("p", {}, t("done_body")),
      el("p", {}, el("a", { href: `/status#${data.ref}` }, t("done_status"))),
    ),
  );
  done.focus();
});

applyLang("en");
