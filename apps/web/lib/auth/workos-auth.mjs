import { AuthError } from './service.mjs';

function requireState(state) {
  const value = String(state || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AuthError('invalid_oauth_state', 400);
  return value;
}

function requireCode(code) {
  const value = String(code || '').trim();
  if (!value || value.length > 4096) throw new AuthError('missing_authorization_code', 400);
  return value;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().normalize('NFKC').toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('invalid_email', 400);
  }
  return email;
}

function requireSixDigitCode(value) {
  const code = String(value || '').trim();
  if (!/^\d{6}$/.test(code)) throw new AuthError('invalid_or_expired_code', 400);
  return code;
}

function statusOf(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
}

function workosError(error, fallbackCode, invalidRequestCode = 'invalid_or_expired_code') {
  const status = statusOf(error);
  if (status === 429) return new AuthError('too_many_sign_in_requests', 429);
  if ([400, 401, 422].includes(status)) return new AuthError(invalidRequestCode, invalidRequestCode === 'invalid_or_expired_code' ? 400 : 503);
  return new AuthError(fallbackCode, 503);
}

function userName(user) {
  return [user?.firstName, user?.lastName]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Thin WorkOS AuthKit adapter; identity linking and app sessions remain Keus-owned. */
export function createWorkOSAuth({ workos, clientId, redirectUri, authService } = {}) {
  if (!workos?.userManagement) throw new TypeError('workos_client_required');
  if (!clientId || !redirectUri) throw new TypeError('workos_client_id_and_redirect_uri_required');
  if (typeof authService?.createWorkOSSession !== 'function'
      || typeof authService?.reserveWorkOSCodeRequest !== 'function') {
    throw new TypeError('workos_session_service_required');
  }

  async function getAuthorizationUrl({ state, provider = 'authkit', screenHint = 'sign-in' } = {}) {
    const safeState = requireState(state);
    const safeProvider = String(provider);
    if (!['authkit', 'GoogleOAuth', 'GitHubOAuth'].includes(safeProvider)) {
      throw new AuthError('unsupported_oauth_provider', 400);
    }
    const safeScreenHint = String(screenHint);
    if (!['sign-in', 'sign-up'].includes(safeScreenHint)) {
      throw new AuthError('invalid_auth_screen', 400);
    }
    return workos.userManagement.getAuthorizationUrl({
      provider: safeProvider,
      clientId,
      redirectUri,
      state: safeState,
      ...(safeProvider === 'authkit' ? { screenHint: safeScreenHint } : {}),
    });
  }

  async function requestEmailCode({ email: rawEmail, now } = {}) {
    const reservation = await authService.reserveWorkOSCodeRequest({ email: rawEmail, now });
    try {
      // WorkOS sends the message; the returned code is deliberately discarded and never reaches the browser.
      await workos.userManagement.createMagicAuth({ email: reservation.email });
    } catch (error) {
      const status = statusOf(error);
      if (status === 401) throw new AuthError('workos_key_rejected', 503);
      if (status === 403) throw new AuthError('workos_access_denied', 503);
      if ([400, 422].includes(status)) throw new AuthError('workos_settings_rejected', 503);
      throw workosError(error, 'email_delivery_failed', 'email_delivery_failed');
    }
    return { accepted: true, expiresAt: reservation.expiresAt };
  }

  async function verifyEmailCode({ email: rawEmail, code: rawCode, ipAddress, userAgent, now } = {}) {
    const email = normalizeEmail(rawEmail);
    const code = requireSixDigitCode(rawCode);
    let result;
    try {
      result = await workos.userManagement.authenticateWithMagicAuth({
        clientId,
        email,
        code,
        ipAddress,
        userAgent,
      });
    } catch (error) {
      throw workosError(error, 'workos_auth_unavailable');
    }
    const user = result?.user;
    if (!user || typeof user !== 'object') throw new AuthError('workos_user_missing', 503);
    return authService.createWorkOSSession({
      providerSubject: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: userName(user),
      now,
    });
  }

  async function completeLogin({ code, ipAddress, userAgent, now }) {
    const authorizationCode = requireCode(code);
    let result;
    try {
      result = await workos.userManagement.authenticateWithCode({
        code: authorizationCode,
        clientId,
        ipAddress,
        userAgent,
      });
    } catch (error) {
      throw workosError(error, 'workos_auth_unavailable');
    }
    const user = result?.user;
    if (!user || typeof user !== 'object') throw new AuthError('workos_user_missing', 503);

    return authService.createWorkOSSession({
      providerSubject: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: userName(user),
      now,
    });
  }

  return Object.freeze({ getAuthorizationUrl, requestEmailCode, verifyEmailCode, completeLogin });
}
