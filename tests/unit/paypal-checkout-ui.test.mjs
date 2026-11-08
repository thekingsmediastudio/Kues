import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validatedSandboxApprovalUrl, expiredCheckoutStatus } from "../../apps/web/public/standard-checkout-ui.mjs";
test("checkout links accept only HTTPS PayPal sandbox hosts without credentials or nonstandard ports", () => {
  for (const url of [
    "https://www.sandbox.paypal.com/checkoutnow?token=TEST",
    "https://sandbox.paypal.com/checkoutnow?token=TEST",
  ])
    assert.equal(validatedSandboxApprovalUrl(url), url);
  for (const url of [
    "https://www.paypal.com/checkoutnow",
    "https://sandbox.paypal.com.evil.test/",
    "http://www.sandbox.paypal.com/",
    "javascript:alert(1)",
    "https://user@www.sandbox.paypal.com/",
    "https://www.sandbox.paypal.com:8443/",
    "not a URL",
  ])
    assert.throws(() => validatedSandboxApprovalUrl(url));
});
test("checkout UI does not require automatic popups or persist approval links in browser storage", () => {
  const source = fs.readFileSync(
    new URL("../../apps/web/public/standard-checkout-ui.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /window\.open\(|localStorage|sessionStorage/);
  assert.match(source, /Copy approval address/);
  assert.match(source, /address\.select\(\)/);
  assert.match(source, /noopener noreferrer/);
  assert.match(source, /!card\.isConnected/);
});


test('expired checkout distinguishes an unconfirmed provider order from an unstarted review',()=>{
 assert.equal(expiredCheckoutStatus({status:'expired',orderId:'ORDER'}),'Approval window expired — PayPal status unconfirmed');
 assert.equal(expiredCheckoutStatus({status:'expired',orderId:null}),'Purchase review expired');
});
