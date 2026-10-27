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

function requirePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 8) throw new AuthError('password_too_short', 400);
  if (password.length > 1024) throw new AuthError('password_too_long', 400);
  return password;
}

function requireSixDigitCode(value) {
  const code = String(value || '').trim();
  if (!/^\d{6}$/.test(code)) throw new AuthError('invalid_or_expired_code', 400);
  return code;
}

function statusOf(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
}

function errorPayload(error) {
  const value = error?.rawData ?? error?.response?.data ?? error?.body ?? null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
}

function providerCode(error) {
  const payload = errorPayload(error);
  return String(payload.code || payload.error || error?.code || error?.error || '').trim().toLowerCase();
}

function pendingAuthenticationToken(error) {
  const payload = errorPayload(error);
  const token = payload.pending_authentication_token || payload.pendingAuthenticationToken
    || error?.pendingAuthenticationToken;
  return typeof token === 'string' && token.length > 0 && token.length <= 4096 ? token : null;
}

function userIdFromError(error) {
  const payload = errorPayload(error);
  const userId = payload.user_id || payload.userId || payload.user?.id || error?.userId;
  return typeof userId === 'string' && userId.length > 0 && userId.length <= 255 ? userId : null;
}

function isEmailVerificationRequired(error) {
  return providerCode(error) === 'email_verification_required';
}

function isExistingUser(error) {
  const code = providerCode(error);
  return statusOf(error) === 409
    || ['user_already_exists', 'email_already_exists', 'user_with_email_exists'].includes(code);
}

function workosError(error, fallbackCode, { password = false, verification = false, passwordReset = false, emailDelivery = false } = {}) {
  const status = statusOf(error);
  const code = providerCode(error);
  if (status === 429) return new AuthError('too_many_sign_in_requests', 429);
  if (verification && (
    ['invalid_one_time_code', 'one_time_code_expired', 'invalid_or_expired_code', 'invalid_grant'].includes(code)
    || [400, 401, 422].includes(status)
  )) return new AuthError('invalid_or_expired_code', 400);
  if (password && ['invalid_credentials', 'invalid_password', 'invalid_email_or_password', 'user_not_found'].includes(code)) {
    return new AuthError('invalid_email_or_password', 401);
  }
  if (passwordReset && status === 404) return new AuthError('password_reset_unavailable', 503);
  if (passwordReset && [400, 422].includes(status)) return new AuthError('password_reset_unavailable', 503);
  if (emailDelivery && [400, 422].includes(status)) return new AuthError('email_delivery_failed', 503);
  if (status === 401) return new AuthError('workos_key_rejected', 503);
  if (status === 403) return new AuthError('workos_access_denied', 503);
  if (password && [400, 422].includes(status)) return new AuthError('invalid_email_or_password', 401);
  if ([400, 422].includes(status)) return new AuthError('password_rejected', 400);
  return new AuthError(fallbackCode, 503);
}

function userName(user) {
  return [user?.firstName, user?.lastName]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

function pendingChallenge(value, email) {
  const pending = String(value || '');
  if (!pending || pending.length > 4096) return null;
  return { kind: 'pending', token: pending, email };
}

function userChallenge(userId, email) {
  const id = String(userId || '');
  if (!id || id.length > 255) return null;
  return { kind: 'user', userId: id, email };
}

/** Thin WorkOS adapter; Keus owns identity linking, local sessions, and workspace provisioning. */
export function createWorkOSAuth({ workos, clientId, redirectUri, authService } = {}) {
  if (!workos?.userManagement) throw new TypeError('workos_client_required');
  if (!clientId || !redirectUri) throw new TypeError('workos_client_id_and_redirect_uri_required');
  if (typeof authService?.createWorkOSSession !== 'function'
      || typeof authService?.reserveWorkOSCodeRequest !== 'function') {
    throw new TypeError('workos_session_service_required');
  }

  async function getAuthorizationUrl({ state, provider = 'GoogleOAuth' } = {}) {
    const safeState = requireState(state);
    const safeProvider = String(provider);
    if (!['GoogleOAuth', 'GitHubOAuth'].includes(safeProvider)) {
      throw new AuthError('unsupported_oauth_provider', 400);
    }
    return workos.userManagement.getAuthorizationUrl({
      provider: safeProvider,
      clientId,
      redirectUri,
      state: safeState,
    });
  }

  async function createKeusSession(result, now) {
    const user = result?.user;
    if (!user || typeof user !== 'object' || !user.id) throw new AuthError('workos_user_missing', 503);
    if (user.emailVerified !== true) throw new AuthError('email_not_verified', 403);
    return authService.createWorkOSSession({
      providerSubject: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: userName(user),
      now,
    });
  }

  async function lookupUserId(email) {
    if (typeof workos.userManagement.listUsers !== 'function') return null;
    try {
      const users = await workos.userManagement.listUsers({ email, limit: 1 });
      const user = Array.isArray(users?.data) ? users.data.find((item) => normalizeEmail(item.email) === email) : null;
      return user?.id || null;
    } catch {
      return null;
    }
  }

  async function authenticatePassword({ email: rawEmail, password: rawPassword, ipAddress, userAgent, now } = {}) {
    const email = normalizeEmail(rawEmail);
    const password = requirePassword(rawPassword);
    let result;
    try {
      result = await workos.userManagement.authenticateWithPassword({
        clientId,
        email,
        password,
        ipAddress,
        userAgent,
      });
    } catch (error) {
      if (isEmailVerificationRequired(error)) {
        let challenge = pendingChallenge(pendingAuthenticationToken(error), email);
        if (!challenge) {
          const userId = userIdFromError(error) || await lookupUserId(email);
          challenge = userChallenge(userId, email);
        }
        if (!challenge) throw new AuthError('email_verification_unavailable', 503);
        return { needsEmailVerification: true, email, challenge };
      }
      throw workosError(error, 'workos_auth_unavailable', { password: true });
    }

    const user = result?.user;
    if (!user || typeof user !== 'object' || !user.id) throw new AuthError('workos_user_missing', 503);
    if (user.emailVerified !== true) {
      const reservation = await authService.reserveWorkOSCodeRequest({ email, now });
      try {
        await workos.userManagement.sendVerificationEmail({ userId: user.id });
      } catch (error) {
        throw workosError(error, 'email_delivery_failed', { emailDelivery: true });
      }
      return {
        needsEmailVerification: true,
        email: reservation.email,
        challenge: userChallenge(user.id, email),
      };
    }

    return {
      needsEmailVerification: false,
      email,
      ...(await createKeusSession(result, now)),
    };
  }

  async function signUpWithPassword({ email: rawEmail, password: rawPassword, ipAddress, userAgent, now } = {}) {
    const email = normalizeEmail(rawEmail);
    const password = requirePassword(rawPassword);
    await authService.reserveWorkOSCodeRequest({ email, now });

    let user;
    try {
      user = await workos.userManagement.createUser({
        email,
        password,
        emailVerified: false,
      });
    } catch (error) {
      if (isExistingUser(error)) {
        // Preserve existing WorkOS IDs and Keus workspaces. A reset link lets passwordless
        // accounts set their first password without changing or duplicating the identity.
        try {
          await workos.userManagement.createPasswordReset({ email });
        } catch (resetError) {
          if (![404].includes(statusOf(resetError)) && providerCode(resetError) !== 'user_not_found') {
            throw workosError(resetError, 'password_reset_unavailable', { passwordReset: true });
          }
        }
        return { needsEmailVerification: false, passwordResetStarted: true, email };
      }
      throw workosError(error, 'workos_auth_unavailable');
    }
    if (!user || typeof user !== 'object' || !user.id) throw new AuthError('workos_user_missing', 503);

    return authenticatePassword({ email, password, ipAddress, userAgent, now });
  }

  async function signInWithPassword({ email, password, ipAddress, userAgent, now } = {}) {
    return authenticatePassword({ email, password, ipAddress, userAgent, now });
  }

  async function resendPasswordVerification({ email, password, ipAddress, userAgent, now } = {}) {
    const normalizedEmail = normalizeEmail(email);
    await authService.reserveWorkOSCodeRequest({ email: normalizedEmail, now });
    return authenticatePassword({ email: normalizedEmail, password, ipAddress, userAgent, now });
  }

  async function verifyPasswordEmail({ challenge: rawChallenge, code: rawCode, email: rawEmail, password: rawPassword, ipAddress, userAgent, now } = {}) {
    const code = requireSixDigitCode(rawCode);
    const challenge = rawChallenge && typeof rawChallenge === 'object' ? rawChallenge : null;
    if (!challenge) throw new AuthError('invalid_or_expired_code', 400);

    if (challenge.kind === 'pending') {
      const token = String(challenge.token || '');
      if (!token || token.length > 4096) throw new AuthError('invalid_or_expired_code', 400);
      let result;
      try {
        result = await workos.userManagement.authenticateWithEmailVerification({
          clientId,
          pendingAuthenticationToken: token,
          code,
          ipAddress,
          userAgent,
        });
      } catch (error) {
        throw workosError(error, 'workos_auth_unavailable', { verification: true });
      }
      return createKeusSession(result, now);
    }

    if (challenge.kind === 'user') {
      const userId = String(challenge.userId || '');
      const email = normalizeEmail(rawEmail || challenge.email);
      const password = requirePassword(rawPassword);
      if (!userId || userId.length > 255 || email !== normalizeEmail(challenge.email)) {
        throw new AuthError('invalid_or_expired_code', 400);
      }
      try {
        const verified = await workos.userManagement.verifyEmail({ userId, code });
        if (!verified?.user || verified.user.emailVerified !== true) throw new AuthError('email_not_verified', 403);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw workosError(error, 'workos_auth_unavailable', { verification: true });
      }
      let result;
      try {
        result = await workos.userManagement.authenticateWithPassword({
          clientId,
          email,
          password,
          ipAddress,
          userAgent,
        });
      } catch (error) {
        throw workosError(error, 'workos_auth_unavailable', { password: true });
      }
      if (result?.user?.id !== userId) throw new AuthError('invalid_email_or_password', 401);
      return createKeusSession(result, now);
    }

    throw new AuthError('invalid_or_expired_code', 400);
  }

  async function startPasswordReset({ email: rawEmail, now } = {}) {
    const email = normalizeEmail(rawEmail);
    await authService.reserveWorkOSCodeRequest({ email, now });
    try {
      await workos.userManagement.createPasswordReset({ email });
    } catch (error) {
      // Keep the response the same for unknown addresses so the endpoint cannot enumerate users.
      if (statusOf(error) !== 404 && providerCode(error) !== 'user_not_found') {
        throw workosError(error, 'password_reset_unavailable', { passwordReset: true });
      }
    }
    return { accepted: true, email };
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
    if (result?.authenticationMethod === 'MagicAuth') throw new AuthError('password_auth_required', 403);
    return createKeusSession(result, now);
  }

  return Object.freeze({
    getAuthorizationUrl,
    signUpWithPassword,
    signInWithPassword,
    resendPasswordVerification,
    verifyPasswordEmail,
    startPasswordReset,
    completeLogin,
  });
}
