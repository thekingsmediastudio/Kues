export function validatedSandboxApprovalUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !["sandbox.paypal.com", "www.sandbox.paypal.com"].includes(u.hostname) ||
    u.port ||
    u.username ||
    u.password
  )
    throw Error("invalid_approval_url");
  return u.href;
}
const copy = (code) =>
  ({
    paypal_not_configured: "PayPal sandbox credentials are not configured.",
    paypal_sandbox_required:
      "This checkout requires sandbox mode; live payments are disabled.",
    paypal_permission_denied:
      "The PayPal app does not permit this checkout request.",
    paypal_credentials_rejected: "PayPal rejected the app credentials.",
    checkout_personal_account_required:
      "Sign in to your own Keus account, not the shared demo account.",
    spend_limit_exceeded: "This purchase exceeds the current spending limits.",
    purchase_approval_expired:
      "This purchase review expired. Ask the agent to prepare a fresh one.",
    checkout_already_started:
      "This checkout already exists. Refresh its status instead of creating another.",
    checkout_processing:
      "PayPal verification is still processing. Wait a moment and recheck.",
    paypal_authorization_unconfirmed:
      "No authorization could be confirmed. Do not start a replacement checkout until this status is resolved.",
  })[code] ||
  "The checkout could not be confirmed. Refresh and recheck its status before trying again.";
export function installCheckoutUI({ getWorkspaceId }) {
  let version = 0;
  const approvalLinks = new Map();
  const list = document.getElementById("checkoutList"),
    status = document.getElementById("checkoutStatus");
  const active = () =>
    document
      .getElementById("generalOverlayBackdrop")
      ?.classList.contains("open") &&
    !document.getElementById("settingsPanePayments")?.hidden;
  async function request(action, mandateId) {
    const r = await fetch("/api/commerce/paypal/checkout/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mandateId }),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    return data.checkout;
  }
  const statuses = {
    ready: "Ready for your PayPal approval",
    creating: "Preparing checkout",
    pending: "Awaiting PayPal approval",
    authorizing: "Verifying authorization — do not repeat checkout",
    authorized: "Sandbox hold authorized — not captured",
    voiding: "Voiding the hold",
    voided: "Sandbox hold voided",
    cancelled: "Cancelled — no authorization",
    failed: "Checkout setup failed — no confirmed hold",
    uncertain: "Authorization uncertain — recheck before any new checkout",
    void_uncertain: "Void uncertain — recheck before retrying",
    expired: "Purchase review expired",
  };
  async function refresh() {
    if (!list || !status) return;
    const v = ++version,
      scope = getWorkspaceId();
    list.replaceChildren();
    status.textContent = "Loading checkouts…";
    try {
      const r = await fetch("/api/commerce/paypal/checkout", {
          cache: "no-store",
        }),
        data = await r.json();
      if (v !== version || scope !== getWorkspaceId()) return;
      if (!r.ok) throw Error(data.error);
      status.textContent = data.checkouts?.length
        ? ""
        : "Review a purchase in chat to prepare checkout.";
      const pendingKeys = new Set(
        (data.checkouts || [])
          .filter((item) => item.status === "pending")
          .map((item) => scope + ":" + item.mandateId),
      );
      for (const key of approvalLinks.keys())
        if (!pendingKeys.has(key)) approvalLinks.delete(key);
      for (const item of data.checkouts || []) render(item, scope);
    } catch (e) {
      if (v === version && scope === getWorkspaceId())
        status.textContent = copy(e.message);
    }
  }
  function render(item, scope) {
    const card = document.createElement("div");
    card.className = "app-settings-card";
    card.dataset.checkoutMandate = item.mandateId;
    const title = document.createElement("h3");
    title.textContent = `${(item.amountMinor / 100).toFixed(2)} ${item.currency} · sandbox checkout`;
    const info = document.createElement("p");
    info.textContent = `Product seller reference: ${item.merchantDomain}. Payment is only to the app’s sandbox test merchant.`;
    const state = document.createElement("p");
    state.setAttribute("role", "status");
    state.textContent = statuses[item.status] || "Status unavailable";
    const ids = document.createElement("p");
    ids.style.cssText = "font:11px/1.6 monospace;overflow-wrap:anywhere";
    ids.textContent = [
      item.orderId && `PayPal order: ${item.orderId}`,
      item.authorizationId && `Authorization: ${item.authorizationId}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const actions = document.createElement("div");
    actions.className = "settings-form-actions";
    card.append(title, info, state, ids, actions);
    list.append(card);
    function button(label, action) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill-btn light";
      b.textContent = label;
      b.onclick = action;
      actions.append(b);
      return b;
    }
    if (["ready", "pending"].includes(item.status)) {
      const linkKey = scope + ":" + item.mandateId;
      const panel = document.createElement("div");
      panel.hidden = true;
      panel.style.cssText = "margin-top:14px;overflow-wrap:anywhere";
      const link = document.createElement("a");
      link.textContent = "Open PayPal sandbox approval ↗";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.style.cssText =
        "display:inline-block;color:#edca84;font-weight:600;padding:8px 0";
      const hint = document.createElement("p");
      hint.textContent =
        "If the preview blocks the link, copy this address into a new browser tab. Approve or cancel on PayPal, then return to Keus. No funds are captured.";
      const label = document.createElement("label");
      label.textContent = "PayPal sandbox approval address";
      label.style.cssText = "display:block;font-size:12px";
      const address = document.createElement("input");
      address.type = "text";
      address.readOnly = true;
      address.style.cssText =
        "box-sizing:border-box;display:block;width:100%;min-width:0;padding:10px;margin:6px 0;background:#202126;color:#eee;border:1px solid #555;border-radius:7px;font-size:12px";
      label.append(address);
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "pill-btn light";
      copyButton.textContent = "Copy approval address";
      copyButton.style.cssText = "background:#eac477;color:#20190b";
      const note = document.createElement("p");
      note.setAttribute("role", "status");
      copyButton.onclick = async () => {
        if (scope !== getWorkspaceId() || !card.isConnected) return;
        try {
          await navigator.clipboard.writeText(address.value);
          if (scope === getWorkspaceId() && card.isConnected)
            note.textContent = "Copied. Paste into a new browser tab.";
        } catch {
          if (scope !== getWorkspaceId() || !card.isConnected) return;
          address.focus();
          address.select();
          note.textContent =
            "Address selected. Press Ctrl+C or Command+C, then paste into a new browser tab.";
        }
      };
      link.addEventListener("click", (event) => {
        if (scope !== getWorkspaceId() || !card.isConnected)
          event.preventDefault();
      });
      panel.append(link, hint, label, copyButton, note);
      card.append(panel);
      const showLink = (value) => {
        const url = validatedSandboxApprovalUrl(value);
        link.href = url;
        address.value = url;
        panel.hidden = false;
      };
      if (approvalLinks.has(linkKey)) showLink(approvalLinks.get(linkKey));
      const beginButton = button(
        item.status === "pending"
          ? "Show PayPal approval link"
          : "Get PayPal approval link",
        async () => {
          if (scope !== getWorkspaceId() || !card.isConnected) return;
          actions
            .querySelectorAll("button")
            .forEach((b) => (b.disabled = true));
          state.textContent = "Preparing the PayPal sandbox approval link…";
          try {
            const checkout = await request("begin", item.mandateId);
            const url = validatedSandboxApprovalUrl(checkout.approveUrl);
            if (scope !== getWorkspaceId() || !card.isConnected) return;
            approvalLinks.set(linkKey, url);
            showLink(url);
            beginButton.textContent = "Show PayPal approval link";
            state.textContent =
              "Awaiting your approval on PayPal — no authorization is confirmed yet.";
          } catch (e) {
            if (scope === getWorkspaceId() && card.isConnected)
              state.textContent = copy(e.message);
          } finally {
            actions
              .querySelectorAll("button")
              .forEach((b) => (b.disabled = false));
          }
        },
      );
    }
    if (
      [
        "authorizing",
        "uncertain",
        "authorized",
        "voiding",
        "void_uncertain",
      ].includes(item.status)
    )
      button("Recheck PayPal status", async () => {
        if (scope !== getWorkspaceId()) return;
        actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          await request("reconcile", item.mandateId);
          window.dispatchEvent(new CustomEvent("keus-checkout-updated",{detail:{mandateId:item.mandateId}}));
          await refresh();
        } catch (e) {
          if (scope === getWorkspaceId()) state.textContent = copy(e.message);
          actions
            .querySelectorAll("button")
            .forEach((b) => (b.disabled = false));
        }
      });
    if (item.status === "authorized")
      button("Void sandbox hold", async () => {
        if (scope !== getWorkspaceId()) return;
        actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          await request("void", item.mandateId);
          window.dispatchEvent(new CustomEvent("keus-checkout-updated",{detail:{mandateId:item.mandateId}}));
          await refresh();
        } catch (e) {
          if (scope === getWorkspaceId()) state.textContent = copy(e.message);
          actions
            .querySelectorAll("button")
            .forEach((b) => (b.disabled = false));
        }
      });
  }
  document
    .getElementById("checkoutRefresh")
    ?.addEventListener("click", refresh);
  window.addEventListener("focus", () => {
    if (active()) void refresh();
  });
  return { refresh };
}
