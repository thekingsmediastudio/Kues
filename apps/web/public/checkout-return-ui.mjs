const valid = (id) =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(id);
export function checkoutNotice(status) {
  return (
    {
      authorized: "Sandbox authorization successful — funds were not captured.",
      voided: "Sandbox hold voided — funds were not captured.",
      cancelled: "Checkout cancelled — no authorization was requested.",
      pending:
        "PayPal authorization is not confirmed. Open PayPal checkout to check the purchase before trying again.",
      expired:
        "This checkout review expired. No successful authorization is being claimed.",
      uncertain:
        "Authorization is uncertain. Recheck PayPal status before starting another purchase.",
      authorizing:
        "Authorization verification is still processing. Do not repeat the purchase.",
      voiding: "The sandbox hold is being voided.",
      void_uncertain: "The void is not confirmed. Recheck PayPal status.",
    }[status] ||
    "Checkout is not confirmed. Check PayPal checkout before trying again."
  );
}
export function installCheckoutReturn({ getContext, showResult, showError }) {
  const url = new URL(location.href);
  let pending = valid(url.searchParams.get("checkout"))
      ? url.searchParams.get("checkout")
      : null,
    busy = false;
  async function resume() {
    const c = getContext();
    if (!pending || busy || !c.ready || c.busy || !c.workspaceId) return;
    const mandateId = pending;
    busy = true;
    try {
      const r = await fetch("/api/commerce/paypal/checkout/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mandateId }),
      });
      const d = await r.json();
      if (!r.ok) throw Error();
      const item = d.checkout,
        latest = getContext();
      if (latest.workspaceId !== c.workspaceId || latest.userId !== c.userId)
        return;
      if (latest.busy) return;
      if (
        !item ||
        item.mandateId !== mandateId ||
        item.workspaceId !== c.workspaceId ||
        !latest.agentIds.includes(item.agentId)
      )
        throw Error();
      pending = null;
      const clean = new URL(location.href);
      clean.searchParams.delete("checkout");
      history.replaceState(
        null,
        "",
        clean.pathname + clean.search + clean.hash,
      );
      await showResult(item, checkoutNotice(item.status));
    } catch {
      if (
        getContext().workspaceId !== c.workspaceId ||
        getContext().userId !== c.userId
      )
        return;
      pending = null;
      showError(
        "Could not retrieve this checkout in your current account/workspace. No payment success is being claimed.",
      );
    } finally {
      busy = false;
    }
  }
  try {
    const channel = new BroadcastChannel("keus-checkout-return");
    channel.onmessage = (e) => {
      if (valid(e.data?.mandateId)) {
        pending = e.data.mandateId;
        void resume();
      }
    };
  } catch {}
  window.addEventListener("keus-checkout-updated", (e) => {
    if (valid(e.detail?.mandateId)) {
      pending = e.detail.mandateId;
      void resume();
    }
  });
  window.addEventListener("focus", () => void resume());
  return { resume };
}
