export function buildShoppingRequest({
  items,
  budget = "",
  currency = "",
  destination = "",
  requirements = "",
} = {}) {
  const clean = (value, max) => {
    if (
      typeof value !== "string" ||
      value.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    )
      throw Error(
        "Please shorten the fields and remove unsupported characters.",
      );
    return value.trim();
  };
  const list = clean(items || "", 700),
    amount = clean(budget, 20),
    unit = clean(currency, 3).toUpperCase(),
    place = clean(destination, 100),
    needs = clean(requirements, 200);
  if (!list) throw Error("Add at least one item.");
  if (list.split(/\n/).filter((x) => x.trim()).length > 8)
    throw Error("Use up to eight items for this shopping brief.");
  if (
    amount &&
    (!/^\d+(?:\.\d{1,2})?$/.test(amount) ||
      Number(amount) <= 0 ||
      Number(amount) > 1000000)
  )
    throw Error(
      "Enter a positive budget without commas, with at most two decimal places.",
    );
  if ((amount && !unit) || (unit && !/^[A-Z]{3}$/.test(unit)))
    throw Error("Enter the three-letter currency code for your budget.");
  return [
    "Help me find and compare products for this shopping brief. This is not permission to buy.",
    "Items and quantities:\n" + list,
    "Total budget: " +
      (amount
        ? amount + " " + unit
        : "Not specified; ask me before recommending a basket."),
    "Delivery destination: " + (place || "Not specified; ask if needed."),
    ...(needs ? ["Requirements: " + needs] : []),
    "Use available catalog evidence; search one item at a time if needed. Keep original currencies and ask before any conversion. Show item subtotals separately from unknown shipping, tax and delivery. Review the basket before any purchase request. Do not create a mandate or payment hold.",
  ].join("\n\n");
}
export function createShoppingBriefUI(adapter) {
  const css = document.createElement("style");
  css.textContent =
    ".shopping-brief[hidden]{display:none!important}.shopping-brief{position:fixed;inset:0;z-index:16000;background:#0009;display:grid;place-items:center;padding:18px}.shopping-brief form{width:min(560px,100%);max-height:90dvh;overflow:auto;background:var(--bg-card,#17191c);color:var(--text-main,#fff);border:1px solid var(--border-strong,#454545);border-radius:18px;padding:22px;box-shadow:0 16px 60px #0008}.shopping-brief header{display:flex;justify-content:space-between;gap:14px;margin-bottom:12px}.shopping-brief h2{font-size:21px}.shopping-brief p{font-size:13px;line-height:1.5;color:var(--text-sec,#aaa);margin:8px 0 14px}.shopping-brief label{display:block;font-size:13px;margin:12px 0 5px}.shopping-brief input,.shopping-brief textarea{width:100%;box-sizing:border-box;background:var(--bg-app,#111);color:inherit;border:1px solid var(--border-strong,#454545);border-radius:8px;padding:10px;font:inherit}.shopping-brief textarea{resize:vertical;min-height:85px}.shopping-brief .pair{display:grid;grid-template-columns:2fr 1fr;gap:12px}.shopping-brief button{padding:10px 14px;border-radius:9px;border:1px solid var(--border-strong,#444);background:var(--bg-hover,#24272b);color:inherit;cursor:pointer}.shopping-brief button[type=submit]{border-color:var(--green,#32d583);color:var(--green,#32d583)}.shopping-brief [role=status]{color:var(--cue-gold,#f5b942)}";
  document.head.append(css);
  const panel = document.createElement("div");
  panel.className = "shopping-brief";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "shoppingBriefTitle");
  panel.innerHTML = `<form><header><h2 id="shoppingBriefTitle">Shopping list & budget</h2><button type="button" data-close aria-label="Close shopping brief">×</button></header><p>List → find & compare → review basket → approve a purchase separately.</p><label for="shoppingItems">Items and quantities</label><textarea id="shoppingItems" name="items" maxlength="700" placeholder="One item per line. Include quantities and must-have specifications." required></textarea><div class="pair"><div><label for="shoppingBudget">Total budget (optional)</label><input id="shoppingBudget" name="budget" inputmode="decimal" maxlength="20" placeholder="Amount, without commas"></div><div><label for="shoppingCurrency">Currency</label><input id="shoppingCurrency" name="currency" maxlength="3" placeholder="e.g. NGN"></div></div><label for="shoppingDestination">Delivery city / country (optional)</label><input id="shoppingDestination" name="destination" maxlength="100" placeholder="No street address needed"><label for="shoppingRequirements">Preferences or constraints (optional)</label><textarea id="shoppingRequirements" name="requirements" maxlength="200" placeholder="Brand preferences, deadline, or acceptable alternatives"></textarea><p>Catalog filters and basket calculations currently use USD. Other currencies are preserved in your brief—not silently converted. Shipping and delivery need verification.</p><p data-status role="status" aria-live="polite"></p><button type="submit">Add to my draft</button><p>This appends to your existing draft. Nothing is sent, ordered or paid until you take the next step. If files are attached, you’ll be asked before detaching their temporary text for catalog search.</p></form>`;
  document.body.append(panel);
  const form = panel.querySelector("form");
  let key = "",
    returnTo = null;
  const contextKey = () => {
    const c = adapter.context();
    return `${c.userId || ""}:${c.agentId || ""}`;
  };
  const close = () => {
    panel.hidden = true;
    returnTo?.focus({preventScroll:true});
  };
  const sync = () => {
    const next = contextKey();
    if (next !== key) {
      key = next;
      form.reset();
      panel.querySelector("[data-status]").textContent = "";
      panel.hidden = true;
    }
  };
  const open = () => {
    sync();
    const c = adapter.context();
    adapter.closeMenu?.();
    if (!c.userId || !c.agentId) {
      adapter.status("Select a saved agent before making a shopping brief.");
      return;
    }
    returnTo = document.activeElement;
    panel.hidden = false;
    form.elements.items.focus();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    sync();
    if (panel.hidden) return;
    try {
      const request = buildShoppingRequest(
        Object.fromEntries(new FormData(form)),
      );
      const c = adapter.context();
      if (c.busy)
        throw Error("Finish or stop the current reply or recording first.");
      const draft = adapter.getDraft();
      const next = draft.trim() ? draft + "\n\n" + request : request;
      if (next.length > 2000)
        throw Error(
          "This would exceed the chat draft limit. Shorten the brief or your existing draft; nothing was changed.",
        );
      if (!adapter.detachFiles()) return;
      adapter.setDraft(next);
      close();
      adapter.focusComposer();
      adapter.status(
        "Shopping brief added to your draft. Review it and press Send when ready. Nothing has been ordered.",
      );
    } catch (error) {
      panel.querySelector("[data-status]").textContent = error.message;
    }
  };
  panel.querySelector("[data-close]").onclick = close;
  panel.onclick = (e) => {
    if (e.target === panel) close();
  };
  panel.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    if (e.key === "Tab") {
      const focusable = [...panel.querySelectorAll("button,input,textarea")];
      const first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document
    .querySelectorAll("[data-open-shopping-brief]")
    .forEach((button) => (button.onclick = open));
  sync();
  return { open, sync };
}
