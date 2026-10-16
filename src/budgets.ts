/**
 * What one person may spend, and what everyone together may.
 *
 * The Rewindly Worker names the person, their plan and the lane a call is for
 * on every `/v1/invoke`; the hop counts it in `UserBudget` (one object per
 * person) and in the broker's global ceiling. Cost is counted in tokens — what
 * every intent already estimates before a call and Google reports after it.
 *
 * ponytail: tokens, not money, and one set of provisional numbers. A token on a
 * lite model costs less than on a full one; a per-model price table is the
 * upgrade once the plans are priced. Override per deployment with the
 * PLAN_LIMITS var (JSON, by plan) and GLOBAL_DAILY_TOKENS.
 */

/** Who a call is for: typed chat and Rem's tools, a save's processing, or a talk session. */
export type Lane = "chat" | "pipeline" | "live";
export const LANES: readonly Lane[] = ["chat", "pipeline", "live"];

export interface PlanLimits {
  /** Tokens in a UTC day, every lane together. */
  dailyTokens: number;
  /** Tokens in a minute, every lane together: what stops a burst. */
  minuteTokens: number;
  /** One person's pipeline calls running at once, so a big import cannot take everyone's turn. */
  pipelineConcurrency: number;
}

const DEFAULT_PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { dailyTokens: 1_000_000, minuteTokens: 200_000, pipelineConcurrency: 2 },
};

/** A plan's limits; a plan nobody configured is treated as free. */
export function limitsFor(plan: string | undefined, raw?: string): PlanLimits {
  let plans = DEFAULT_PLAN_LIMITS;
  if (raw) {
    try {
      plans = { ...DEFAULT_PLAN_LIMITS, ...(JSON.parse(raw) as Record<string, PlanLimits>) };
    } catch {
      // A var that does not parse keeps the defaults rather than opening the gate.
    }
  }
  return plans[plan ?? "free"] ?? (plans.free as PlanLimits);
}

const DEFAULT_GLOBAL_DAILY_TOKENS = 50_000_000;

/** What everyone together may spend in a UTC day. */
export function globalCeiling(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GLOBAL_DAILY_TOKENS;
}

export const MINUTE = 60_000;
export const DAY = 86_400_000;

/** The start of the UTC day, and of the minute, that `now` falls in. */
export const dayStart = (now: number) => now - (now % DAY);
export const minuteStart = (now: number) => now - (now % MINUTE);
