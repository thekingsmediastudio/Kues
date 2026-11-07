// Server-written provenance. Older rows lack this and are not verified merely
// because their stored currency says USD.
export function currencyEvidenceRef(product) {
  return JSON.stringify({keusCurrencyEvidence: 1, explicit: product.currencyVerified === true, currency: product.currency, original: product.evidenceRef || null});
}
export function hasExplicitCurrency(ref, currency) {
  try { const v = JSON.parse(ref); return v?.keusCurrencyEvidence === 1 && v.explicit === true && v.currency === currency; }
  catch { return false; }
}
