export class ConfigError extends Error {
  constructor(issues) {
    super(`Invalid server configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function parseAllowedOrigins(value) {
  if (!value || !String(value).trim()) return { origins: [], issues: [] };

  const origins = [];
  const issues = [];
  for (const raw of String(value).split(',')) {
    const candidate = raw.trim();
    if (!candidate) continue;
    if (candidate === '*') {
      issues.push('CORS_ALLOWED_ORIGINS must not contain wildcard origins');
      continue;
    }
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== candidate) {
        issues.push('CORS_ALLOWED_ORIGINS entries must be bare http(s) origins without paths');
        continue;
      }
      origins.push(parsed.origin);
    } catch {
      issues.push('CORS_ALLOWED_ORIGINS contains an invalid origin');
    }
  }
  return { origins: [...new Set(origins)], issues };
}

function validateAppOrigin(value, issues) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))
        || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      issues.push('APP_BASE_URL must be an HTTPS origin (HTTP is allowed only on localhost)');
    }
  } catch {
    issues.push('APP_BASE_URL must be a valid HTTPS origin');
  }
}

function validateWorkOSRedirectUri(value, issues) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || parsed.pathname !== '/auth/callback') {
      issues.push('WORKOS_REDIRECT_URI must be an HTTPS callback URL ending in /auth/callback (HTTP is allowed only on localhost)');
    }
  } catch {
    issues.push('WORKOS_REDIRECT_URI must be a valid HTTPS callback URL');
  }
}

function isValid32ByteEncryptionKey(value) {
  const input = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(input)) return Buffer.from(input, 'hex').length === 32;
  const keyBytes = Buffer.from(input, 'base64');
  return keyBytes.length === 32
    && keyBytes.toString('base64').replace(/=+$/, '') === input.replace(/=+$/, '');
}

/**
 * Reads only server-side configuration. Secrets are deliberately not returned in this object.
 * Cross-origin browser access is opt-in; same-origin desktop requests need no CORS allowlist.
 */
export function loadServerConfig(env = process.env) {
  const issues = [];
  const webResearchFlag = String(env.WEB_RESEARCH_ENABLED || '').trim();
  if (webResearchFlag && !['0', '1'].includes(webResearchFlag)) issues.push('WEB_RESEARCH_ENABLED must be 0 or 1');
  const webResearchEnabled = webResearchFlag === '1';
  const groqTranscriptionFlag = String(env.GROQ_TRANSCRIPTION_ENABLED || '').trim();
  if (groqTranscriptionFlag && !['0', '1'].includes(groqTranscriptionFlag)) issues.push('GROQ_TRANSCRIPTION_ENABLED must be 0 or 1');
  const groqTranscriptionEnabled = groqTranscriptionFlag === '1';
  const groqTranscriptionModel = String(env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3');
  if (!['whisper-large-v3', 'whisper-large-v3-turbo'].includes(groqTranscriptionModel)) issues.push('GROQ_TRANSCRIPTION_MODEL must be whisper-large-v3 or whisper-large-v3-turbo');
  const paypalMode = String(env.PAYPAL_ENV || 'sandbox').trim().toLowerCase();
  if (paypalMode !== 'sandbox') {
    issues.push('PAYPAL_ENV must be sandbox; live payment mode is out of scope');
  }

  const clientId = String(env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(env.PAYPAL_CLIENT_SECRET || '').trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    issues.push('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set together');
  }

  const parsedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  issues.push(...parsedOrigins.issues);

  const apiHubAdminEmails = [...new Set(String(env.API_HUB_ADMIN_EMAILS || '')
    .split(',').map((email) => email.trim().normalize('NFKC').toLowerCase()).filter(Boolean))];
  if (apiHubAdminEmails.some((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    issues.push('API_HUB_ADMIN_EMAILS must contain comma-separated valid email addresses');
  }
  const apiHubEncryptionKey = String(env.API_HUB_ENCRYPTION_KEY || '').trim();
  if (apiHubAdminEmails.length && !isValid32ByteEncryptionKey(apiHubEncryptionKey)) {
    issues.push('API_HUB_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hexadecimal key when the API Hub is enabled');
  }

  const aiProviderAdminEmails = [...new Set(String(env.AI_PROVIDER_ADMIN_EMAILS || '')
    .split(',').map((email) => email.trim().normalize('NFKC').toLowerCase()).filter(Boolean))];
  if (aiProviderAdminEmails.some((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    issues.push('AI_PROVIDER_ADMIN_EMAILS must contain comma-separated valid email addresses');
  }
  const aiProviderEncryptionKey = String(env.AI_PROVIDER_ENCRYPTION_KEY || '').trim();
  if (aiProviderAdminEmails.length && !isValid32ByteEncryptionKey(aiProviderEncryptionKey)) {
    issues.push('AI_PROVIDER_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hexadecimal key when AI provider administration is enabled');
  }
  const aiProviderChatTestFlag = String(env.AI_PROVIDER_CHAT_TEST_ENABLED || '').trim();
  if (aiProviderChatTestFlag && !['0', '1'].includes(aiProviderChatTestFlag)) {
    issues.push('AI_PROVIDER_CHAT_TEST_ENABLED must be 0 or 1');
  }
  const aiProviderChatTestEnabled = aiProviderChatTestFlag === '1';
  if (aiProviderChatTestEnabled && !aiProviderAdminEmails.length) {
    issues.push('AI_PROVIDER_CHAT_TEST_ENABLED requires AI_PROVIDER_ADMIN_EMAILS');
  }

  // Explicitly opt in authenticated staging users; provider administration remains separate.
  const userChatFlag = String(env.AI_PROVIDER_CHAT_USERS_ENABLED || '').trim();
  if (userChatFlag && !['0','1'].includes(userChatFlag)) issues.push('AI_PROVIDER_CHAT_USERS_ENABLED must be 0 or 1');
  const aiProviderChatUsersEnabled = userChatFlag === '1';
  if (aiProviderChatUsersEnabled && !aiProviderChatTestEnabled) issues.push('AI_PROVIDER_CHAT_USERS_ENABLED requires AI_PROVIDER_CHAT_TEST_ENABLED');

  const databaseUrl = String(env.TURSO_DATABASE_URL || '').trim();
  const databaseToken = String(env.TURSO_AUTH_TOKEN || '').trim();
  const remoteDatabase = databaseUrl.startsWith('libsql://') || databaseUrl.startsWith('https://');
  if (databaseToken && !databaseUrl) issues.push('TURSO_AUTH_TOKEN requires TURSO_DATABASE_URL');
  if (remoteDatabase && !databaseToken) issues.push('TURSO_AUTH_TOKEN is required for remote Turso databases');

  const authProvider = String(env.AUTH_PROVIDER || '').trim().toLowerCase();
  if (authProvider && !['workos', 'brevo'].includes(authProvider)) {
    issues.push('AUTH_PROVIDER must be workos or brevo');
  }
  if (apiHubAdminEmails.length && authProvider !== 'workos') {
    issues.push('API_HUB_ADMIN_EMAILS requires AUTH_PROVIDER=workos');
  }
  if (apiHubAdminEmails.length && !databaseUrl) {
    issues.push('TURSO_DATABASE_URL is required when the API Hub is enabled');
  }
  if (aiProviderAdminEmails.length && authProvider !== 'workos') {
    issues.push('AI_PROVIDER_ADMIN_EMAILS requires AUTH_PROVIDER=workos');
  }
  if (aiProviderAdminEmails.length && !databaseUrl) {
    issues.push('TURSO_DATABASE_URL is required when AI provider administration is enabled');
  }

  const workosApiKey = String(env.WORKOS_API_KEY || '').trim();
  const workosClientId = String(env.WORKOS_CLIENT_ID || '').trim();
  const googleOAuthFlag = String(env.WORKOS_GOOGLE_OAUTH_ENABLED || '').trim();
  const githubOAuthFlag = String(env.WORKOS_GITHUB_OAUTH_ENABLED || '').trim();
  if (googleOAuthFlag && !['0', '1'].includes(googleOAuthFlag)) issues.push('WORKOS_GOOGLE_OAUTH_ENABLED must be 0 or 1');
  if (githubOAuthFlag && !['0', '1'].includes(githubOAuthFlag)) issues.push('WORKOS_GITHUB_OAUTH_ENABLED must be 0 or 1');
  if ((googleOAuthFlag === '1' || githubOAuthFlag === '1') && authProvider !== 'workos') {
    issues.push('Google/GitHub OAuth flags require AUTH_PROVIDER=workos');
  }
  let renderCallbackDefault = '';
  const renderExternalUrl = String(env.RENDER_EXTERNAL_URL || '').trim();
  if (renderExternalUrl) {
    try {
      renderCallbackDefault = new URL('/auth/callback', renderExternalUrl).toString();
    } catch {
      // The normal redirect validation below reports an invalid platform URL without echoing it.
    }
  }
  const workosRedirectUri = String(env.WORKOS_REDIRECT_URI || renderCallbackDefault).trim();
  const hasWorkOSSettings = Boolean(workosApiKey || workosClientId || workosRedirectUri);
  if (authProvider === 'workos') {
    if (!databaseUrl) issues.push('TURSO_DATABASE_URL is required when WorkOS authentication is enabled');
    if (!workosApiKey) issues.push('WORKOS_API_KEY is required for WorkOS authentication');
    if (!workosClientId) issues.push('WORKOS_CLIENT_ID is required for WorkOS authentication');
    if (!workosRedirectUri) issues.push('WORKOS_REDIRECT_URI is required for WorkOS authentication');
    if (workosRedirectUri) validateWorkOSRedirectUri(workosRedirectUri, issues);
    if (env.EMAIL_PROVIDER || env.BREVO_API_KEY || env.EMAIL_FROM || env.APP_BASE_URL) {
      issues.push('Brevo email settings cannot be enabled together with AUTH_PROVIDER=workos');
    }
  } else if (hasWorkOSSettings) {
    issues.push('AUTH_PROVIDER=workos is required when WorkOS settings are present');
  }

  const emailProvider = String(env.EMAIL_PROVIDER || '').trim().toLowerCase();
  const brevoApiKey = String(env.BREVO_API_KEY || '').trim();
  const emailFrom = String(env.EMAIL_FROM || '').trim();
  const appBaseUrl = String(env.APP_BASE_URL || '').trim();
  if (emailProvider && emailProvider !== 'brevo') {
    issues.push('EMAIL_PROVIDER must be brevo when email delivery is enabled');
  }
  const competitionStartRaw = String(env.KEUS_COMPETITION_START_AT || '').trim();
  const competitionEndRaw = String(env.KEUS_COMPETITION_END_AT || '').trim();
  const competitionLimitRaw = String(env.KEUS_COMPETITION_DAILY_TOKEN_LIMIT || '').trim();
  const hasAnyCompetitionSetting = Boolean(competitionStartRaw || competitionEndRaw || competitionLimitRaw);
  let competition = null;
  if (hasAnyCompetitionSetting) {
    if (!competitionStartRaw || !competitionEndRaw || !competitionLimitRaw) {
      issues.push('KEUS_COMPETITION_START_AT, KEUS_COMPETITION_END_AT, and KEUS_COMPETITION_DAILY_TOKEN_LIMIT must be set together');
    } else {
      const explicitTimezone = (value) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
      const startMs = Date.parse(competitionStartRaw);
      const endMs = Date.parse(competitionEndRaw);
      const dailyTokenLimit = Number(competitionLimitRaw);
      if (!explicitTimezone(competitionStartRaw) || !Number.isFinite(startMs)) {
        issues.push('KEUS_COMPETITION_START_AT must be an ISO-8601 timestamp with an explicit timezone');
      }
      if (!explicitTimezone(competitionEndRaw) || !Number.isFinite(endMs)) {
        issues.push('KEUS_COMPETITION_END_AT must be an ISO-8601 timestamp with an explicit timezone');
      }
      if (!/^\d+$/.test(competitionLimitRaw) || !Number.isSafeInteger(dailyTokenLimit) || dailyTokenLimit <= 0) {
        issues.push('KEUS_COMPETITION_DAILY_TOKEN_LIMIT must be a positive integer');
      }
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
        issues.push('KEUS_COMPETITION_END_AT must follow KEUS_COMPETITION_START_AT');
      }
      if (explicitTimezone(competitionStartRaw) && explicitTimezone(competitionEndRaw)
          && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
          && /^\d+$/.test(competitionLimitRaw) && Number.isSafeInteger(dailyTokenLimit) && dailyTokenLimit > 0) {
        competition = Object.freeze({
          startAt: new Date(startMs).toISOString(),
          endAt: new Date(endMs).toISOString(),
          dailyTokenLimit,
        });
      }
    }
  }
  const hasEmailSettings = Boolean(emailProvider || brevoApiKey || emailFrom || appBaseUrl);
  if (authProvider === 'brevo' || hasEmailSettings) {
    if (authProvider !== 'brevo') issues.push('AUTH_PROVIDER=brevo is required for Brevo email delivery');
    if (!databaseUrl) issues.push('TURSO_DATABASE_URL is required when email sign-in is configured');
    if (emailProvider !== 'brevo') issues.push('EMAIL_PROVIDER=brevo is required for Brevo email delivery');
    if (!brevoApiKey) issues.push('BREVO_API_KEY is required for Brevo email delivery');
    if (!emailFrom) issues.push('EMAIL_FROM is required for Brevo email delivery');
    if (!appBaseUrl) issues.push('APP_BASE_URL is required for Brevo email delivery');
    if (emailFrom && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFrom)) {
      issues.push('EMAIL_FROM must be a valid sender address');
    }
    if (appBaseUrl) validateAppOrigin(appBaseUrl, issues);
  }

  if (issues.length) throw new ConfigError(issues);

  const workosConfigured = authProvider === 'workos' && Boolean(workosApiKey && workosClientId && workosRedirectUri);
  const channel3ApiKey = String(env.CHANNEL3_API_KEY || '').trim();
  return Object.freeze({
    nodeEnv: String(env.NODE_ENV || 'development').trim(),
    paypalMode,
    paypalConfigured: Boolean(clientId && clientSecret),
    channel3Configured: Boolean(channel3ApiKey),
    databaseConfigured: Boolean(databaseUrl),
    authProvider: authProvider || null,
    workosConfigured,
    workosGoogleOAuthEnabled: workosConfigured && googleOAuthFlag === '1',
    workosGithubOAuthEnabled: workosConfigured && githubOAuthFlag === '1',
    workosRedirectUri: authProvider === 'workos' ? workosRedirectUri : null,
    emailProvider: emailProvider || null,
    emailDeliveryConfigured: authProvider === 'brevo' && emailProvider === 'brevo'
      && Boolean(brevoApiKey && emailFrom && appBaseUrl),
    competition,
    allowedOrigins: Object.freeze(parsedOrigins.origins),
    apiHubEnabled: apiHubAdminEmails.length > 0,
    apiHubAdminEmails: Object.freeze(apiHubAdminEmails),
    aiProvidersEnabled: aiProviderAdminEmails.length > 0,
    aiProviderAdminEmails: Object.freeze(aiProviderAdminEmails),
    aiProviderChatTestEnabled,
    aiProviderChatUsersEnabled,
    webResearchEnabled,
    groqTranscriptionEnabled,
    groqTranscriptionModel,
  });
}
