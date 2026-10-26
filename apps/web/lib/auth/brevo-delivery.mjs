const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

function requireText(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name}_required`);
  return normalized;
}

function validateBaseUrl(value) {
  const raw = requireText(value, 'app_base_url');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('app_base_url_invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== '/') {
    throw new TypeError('app_base_url_must_be_https_origin');
  }
  return parsed.origin;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

/** Brevo transactional-email adapter. The API key remains server-side. */
export function createBrevoEmailDelivery({
  apiKey,
  senderEmail,
  senderName = 'Keus',
  appBaseUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  const secret = requireText(apiKey, 'brevo_api_key');
  const fromEmail = requireText(senderEmail, 'email_from');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw new TypeError('email_from_invalid');
  const fromName = String(senderName || 'Keus').trim().slice(0, 100) || 'Keus';
  const base = validateBaseUrl(appBaseUrl);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch_required');

  return Object.freeze({
    async sendMagicLink({ email, token }) {
      const link = new URL('/auth/verify', base);
      link.searchParams.set('token', String(token));
      const href = link.toString();
      const safeHref = escapeHtml(href);
      const textContent = `Use this one-time Keus sign-in link. It expires in 15 minutes.\n\n${href}\n\nIf you did not request this link, you can ignore this email.`;
      const htmlContent = `<p>Use this one-time Keus sign-in link. It expires in 15 minutes.</p><p><a href="${safeHref}">Sign in to Keus</a></p><p>If you did not request this link, you can ignore this email.</p>`;

      let response;
      try {
        response = await fetchImpl(BREVO_SEND_URL, {
          method: 'POST',
          headers: { 'api-key': secret, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            sender: { name: fromName, email: fromEmail },
            to: [{ email }],
            subject: 'Your Keus sign-in link',
            textContent,
            htmlContent,
            tags: ['keus-auth'],
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error('brevo_transport_failed');
      }
      if (!response.ok) throw new Error(`brevo_rejected_${response.status}`);
      return { accepted: true };
    },
  });
}
