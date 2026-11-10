import crypto from 'node:crypto';
import { inspectWithSentinel } from './sentinel.mjs';

/**
 * Upgrade 2 (ChatGPT Dots style): Proactive "Watch & Auto-Hold" Goals + Live Takeover Mode.
 *
 * Lets a user set a 1-line ongoing goal (e.g. "Watch Rode Wireless GO II; if <= $85, place
 * a PayPal AUTHORIZE hold and ping my phone for passkey approval").
 * Never auto-captures funds; always stops at HOLD_AWAITING_PASSKEY.
 */
export function createWatchGoal({
  title,
  targetMaxCents,
  currency = 'USD',
  allowedDomains = [],
  controlMode = 'AUTONOMOUS', // 'AUTONOMOUS' | 'STEER' | 'TAKE_OVER'
}) {
  if (!title || typeof targetMaxCents !== 'number' || targetMaxCents <= 0) {
    throw new Error('Watch goal requires a title and positive targetMaxCents');
  }
  return {
    goalId: `goal_${crypto.randomBytes(4).toString('hex')}`,
    title,
    targetMaxCents,
    currency,
    allowedDomains,
    controlMode,
    status: 'WATCHING', // 'WATCHING' | 'PAUSED_TAKEOVER' | 'HOLD_AWAITING_PASSKEY' | 'BLOCKED_BY_SENTINEL'
    history: [],
  };
}

/**
 * Switches live control mode ('AUTONOMOUS' | 'STEER' | 'TAKE_OVER') or injects a live steering note.
 */
export function setGoalControlMode(goal, mode, steeringNote = null) {
  const validModes = ['AUTONOMOUS', 'STEER', 'TAKE_OVER'];
  if (!validModes.includes(mode)) {
    throw new Error(`Invalid control mode: ${mode}`);
  }
  const updated = {
    ...goal,
    controlMode: mode,
    status: mode === 'TAKE_OVER' ? 'PAUSED_TAKEOVER' : goal.status === 'PAUSED_TAKEOVER' ? 'WATCHING' : goal.status,
    lastSteeringNote: steeringNote || goal.lastSteeringNote || null,
    history: [
      ...goal.history,
      {
        at: new Date().toISOString(),
        event: `mode:${mode}`,
        note: steeringNote,
      },
    ],
  };
  return updated;
}

/**
 * Evaluates a market price observation against a proactive Watch Goal.
 * If price <= targetMaxCents and Sentinel passes, transitions to HOLD_AWAITING_PASSKEY.
 */
export function evaluateWatchTick(goal, observation) {
  if (goal.controlMode === 'TAKE_OVER') {
    return {
      action: 'SKIP_MANUAL_TAKEOVER',
      goal,
    };
  }

  const { observedPriceCents, merchantDomain, payee, domText = '', adbText = '' } = observation;

  const syntheticMandate = {
    amountCents: observedPriceCents,
    currency: goal.currency,
    payee: payee || `checkout@${merchantDomain}`,
    merchantDomain,
    policyCeilingCents: goal.targetMaxCents,
  };

  const syntheticPolicy = {
    maxPerOrderCents: goal.targetMaxCents,
    maxPerRunCents: goal.targetMaxCents,
    expectedCurrency: goal.currency,
    allowedDomains: goal.allowedDomains,
    blockedPayees: [],
  };

  // First check if price is still above target (unless it's a prompt injection attempt)
  const sentinelCheck = inspectWithSentinel({
    domText,
    adbText,
    quotedPriceCents: observedPriceCents,
    checkoutPriceCents: observedPriceCents,
    mandate: syntheticMandate,
    policy: syntheticPolicy,
  });

  if (sentinelCheck.code === 'sentinel_prompt_injection_detected') {
    const blockedGoal = {
      ...goal,
      status: 'BLOCKED_BY_SENTINEL',
      history: [...goal.history, { at: new Date().toISOString(), event: sentinelCheck.code }],
    };
    return {
      action: 'BLOCK_INJECTION',
      reason: sentinelCheck.detail,
      goal: blockedGoal,
    };
  }

  if (observedPriceCents > goal.targetMaxCents) {
    return {
      action: 'KEEP_WATCHING',
      reason: `price_above_target:${observedPriceCents}>${goal.targetMaxCents}`,
      goal,
    };
  }

  if (sentinelCheck.verdict !== 'ALLOW') {
    return {
      action: 'BLOCK_POLICY',
      reason: sentinelCheck.detail,
      goal,
    };
  }

  const readyGoal = {
    ...goal,
    status: 'HOLD_AWAITING_PASSKEY',
    matchedOffer: {
      observedPriceCents,
      merchantDomain,
      payee: syntheticMandate.payee,
    },
    history: [
      ...goal.history,
      {
        at: new Date().toISOString(),
        event: 'target_met_hold_placed',
        observedPriceCents,
        merchantDomain,
      },
    ],
  };

  return {
    action: 'AUTHORIZE_HOLD_AND_PING_PHONE',
    goal: readyGoal,
  };
}
