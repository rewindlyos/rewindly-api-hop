import { DurableObject } from "cloudflare:workers";
import { DAY, dayStart, type Lane, MINUTE, minuteStart, type PlanLimits } from "./budgets";

/**
 * One person's spend, one object per person (`idFromName(user_id)`).
 *
 * A Durable Object for the reason the broker is one: two calls for the same
 * person must not both read "room for one more" and both go. Everything inside
 * `reserve` is synchronous SQL, so the check and the charge cannot interleave.
 *
 * Reserve before the call, at the intent's estimate; settle after, at what it
 * really cost. A pipeline reservation also holds a slot until it settles, so a
 * person's processing runs at most `pipelineConcurrency` calls at once; a slot a
 * caller never settles (its Worker died mid-call) frees itself after ten
 * minutes, longer than any one call may run.
 */

const SLOT_TTL = 10 * MINUTE;

export type Reserve =
  | { ok: true; ticket: string }
  | { ok: false; why: "daily" | "minute" | "concurrency"; retryAt: number };

interface Spend {
  [column: string]: SqlStorageValue;
  day_win: number;
  day_used: number;
  min_win: number;
  min_used: number;
}

export class UserBudget extends DurableObject {
  private ready = false;

  private get sql(): SqlStorage {
    if (!this.ready) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS spend (
          id       INTEGER PRIMARY KEY CHECK (id = 1),
          day_win  INTEGER NOT NULL,
          day_used INTEGER NOT NULL,
          min_win  INTEGER NOT NULL,
          min_used INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS slots (
          ticket  TEXT PRIMARY KEY,
          lane    TEXT NOT NULL,
          expires INTEGER NOT NULL
        );
      `);
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }

  /** This UTC day's and this minute's spend; windows roll on read, not on a timer. */
  private spend(now: number): Spend {
    const row = this.sql.exec<Spend>("SELECT * FROM spend WHERE id = 1").toArray()[0];
    const day = dayStart(now);
    const minute = minuteStart(now);
    return {
      day_win: day,
      day_used: row && row.day_win === day ? row.day_used : 0,
      min_win: minute,
      min_used: row && row.min_win === minute ? row.min_used : 0,
    };
  }

  private write(s: Spend): void {
    this.sql.exec(
      `INSERT INTO spend (id, day_win, day_used, min_win, min_used) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET day_win = excluded.day_win, day_used = excluded.day_used,
         min_win = excluded.min_win, min_used = excluded.min_used`,
      s.day_win,
      s.day_used,
      s.min_win,
      s.min_used,
    );
  }

  reserve(lane: Lane, limits: PlanLimits, est: number, now: number): Reserve {
    this.sql.exec("DELETE FROM slots WHERE expires <= ?", now);
    const s = this.spend(now);
    if (s.day_used + est > limits.dailyTokens) {
      return { ok: false, why: "daily", retryAt: s.day_win + DAY };
    }
    if (s.min_used + est > limits.minuteTokens) {
      return { ok: false, why: "minute", retryAt: s.min_win + MINUTE };
    }
    if (lane === "pipeline") {
      const running = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM slots WHERE lane = 'pipeline'")
        .one().n;
      if (running >= limits.pipelineConcurrency) {
        const soonest = this.sql
          .exec<{ t: number }>("SELECT MIN(expires) AS t FROM slots WHERE lane = 'pipeline'")
          .one().t;
        // Back soon: a slot frees when a call settles, usually in seconds.
        return { ok: false, why: "concurrency", retryAt: Math.min(soonest, now + 15_000) };
      }
    }
    this.write({ ...s, day_used: s.day_used + est, min_used: s.min_used + est });
    const ticket = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO slots (ticket, lane, expires) VALUES (?, ?, ?)",
      ticket,
      lane,
      now + SLOT_TTL,
    );
    return { ok: true, ticket };
  }

  /** The call is over: its slot frees, and the estimate becomes what it really cost. */
  settle(ticket: string, est: number, actual: number, now: number): void {
    this.sql.exec("DELETE FROM slots WHERE ticket = ?", ticket);
    const s = this.spend(now);
    const delta = actual - est;
    this.write({
      ...s,
      day_used: Math.max(0, s.day_used + delta),
      min_used: Math.max(0, s.min_used + delta),
    });
  }

  /** For the debug route and the tests. */
  usage(now: number): { dayTokens: number; minuteTokens: number; pipelineInFlight: number } {
    this.sql.exec("DELETE FROM slots WHERE expires <= ?", now);
    const s = this.spend(now);
    const running = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM slots WHERE lane = 'pipeline'")
      .one().n;
    return { dayTokens: s.day_used, minuteTokens: s.min_used, pipelineInFlight: running };
  }
}
