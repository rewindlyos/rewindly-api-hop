import { DurableObject } from "cloudflare:workers";
import { MODEL_QUOTAS, quotaFor } from "./quotas";

/**
 * Per-key, per-model usage counters, and the decision of which key serves a
 * request.
 *
 * A Durable Object rather than KV, and the reason is not "DOs are good
 * practice". Workers KV is eventually consistent: on a 5 RPM budget with one
 * request of headroom left, two concurrent requests both read `4 used`, both
 * decide they fit, and both fire. A DO is single-threaded, so the read and the
 * increment below cannot interleave -- which is the entire mechanism.
 *
 * Every selection path here is synchronous inside. `sql.exec` does not yield,
 * so `reserve()` runs check-then-increment with nothing able to land between
 * the two. Do not introduce an `await` into that loop.
 *
 * This object is touched ONCE per request, before the upstream call, and once
 * after to reconcile tokens. For a live session it is touched only at
 * admission: the socket that follows runs directly between the caller and
 * Google on the reserved key, with nothing from this class in the audio path.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface Reservation {
  keyId: string;
  model: string;
}

export interface UsageRow {
  key_id: string;
  model: string;
  rpm_used: number;
  tpm_used: number;
  rpd_used: number;
  /** ms until this (key, model) is retried after an upstream 429. */
  blocked_for_ms: number;
  limits: { rpm: number | null; tpm: number | null; rpd: number | null };
}

interface Row {
  /** `sql.exec<T>` requires rows to be indexable; these are the real columns. */
  [column: string]: SqlStorageValue;
  key_id: string;
  model: string;
  rpm_used: number;
  rpm_win: number;
  tpm_used: number;
  tpm_win: number;
  rpd_used: number;
  rpd_win: number;
  blocked_until: number;
}

/** `Infinity` survives neither SQLite nor JSON; null is how it travels. */
const finite = (n: number): number | null => (Number.isFinite(n) ? n : null);

export class QuotaBroker extends DurableObject {
  private ready = false;

  private get sql(): SqlStorage {
    if (!this.ready) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS usage (
          key_id        TEXT    NOT NULL,
          model         TEXT    NOT NULL,
          rpm_used      INTEGER NOT NULL DEFAULT 0,
          rpm_win       INTEGER NOT NULL DEFAULT 0,
          tpm_used      INTEGER NOT NULL DEFAULT 0,
          tpm_win       INTEGER NOT NULL DEFAULT 0,
          rpd_used      INTEGER NOT NULL DEFAULT 0,
          rpd_win       INTEGER NOT NULL DEFAULT 0,
          blocked_until INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (key_id, model)
        )
      `);
      this.ready = true;
    }
    return this.ctx.storage.sql;
  }

  /**
   * Windows expire on read, not on a timer.
   *
   * The alarm below is a cleanup sweep, not the mechanism -- a counter that
   * only reset when an alarm fired would over-report for up to an hour after a
   * quiet period, and refuse traffic it had budget for.
   */
  private roll(row: Row, now: number): Row {
    if (now - row.rpm_win >= MINUTE) {
      row.rpm_used = 0;
      row.rpm_win = now;
    }
    if (now - row.tpm_win >= MINUTE) {
      row.tpm_used = 0;
      row.tpm_win = now;
    }
    // Rolling 24h anchored to first use, not to midnight UTC: the console's day
    // is per-project and we do not know when it starts.
    if (now - row.rpd_win >= DAY) {
      row.rpd_used = 0;
      row.rpd_win = now;
    }
    return row;
  }

  private read(keyId: string, model: string, now: number): Row {
    const found = this.sql
      .exec<Row>("SELECT * FROM usage WHERE key_id = ? AND model = ?", keyId, model)
      .toArray()[0];
    if (found) return this.roll({ ...found }, now);
    return {
      key_id: keyId,
      model,
      rpm_used: 0,
      rpm_win: now,
      tpm_used: 0,
      tpm_win: now,
      rpd_used: 0,
      rpd_win: now,
      blocked_until: 0,
    };
  }

  private write(r: Row): void {
    this.sql.exec(
      `INSERT INTO usage
         (key_id, model, rpm_used, rpm_win, tpm_used, tpm_win, rpd_used, rpd_win, blocked_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, model) DO UPDATE SET
         rpm_used = excluded.rpm_used, rpm_win = excluded.rpm_win,
         tpm_used = excluded.tpm_used, tpm_win = excluded.tpm_win,
         rpd_used = excluded.rpd_used, rpd_win = excluded.rpd_win,
         blocked_until = excluded.blocked_until`,
      r.key_id,
      r.model,
      r.rpm_used,
      r.rpm_win,
      r.tpm_used,
      r.tpm_win,
      r.rpd_used,
      r.rpd_win,
      r.blocked_until,
    );
  }

  /**
   * Pick a (key, model) and charge it, in one indivisible step.
   *
   * Candidate models are walked in the intent's preference order; within a
   * model, the key with the most headroom wins -- lowest of
   * `max(rpm_used/rpm_limit, rpd_used/rpd_limit)` among keys that fit on all
   * three axes. That spreads load instead of draining key-1 before key-2 sees a
   * request, which is what plain round-robin does and why round-robin is not
   * enough here: the keys stop carrying equal usage the moment one retry lands.
   *
   * The counters move BEFORE the upstream call. A burst of concurrent requests
   * that all read "has room" and all fire is the exact failure this prevents,
   * and it costs an over-count when a request later fails for a non-quota
   * reason. Over-counting a free tier is the safe direction.
   *
   * `skip` carries the (key, model) pairs this request has already tried and
   * been refused by, so a retry cannot be handed the same pair twice.
   */
  async reserve(
    keyIds: string[],
    models: string[],
    estTokens: number,
    skip: Array<[string, string]> = [],
  ): Promise<Reservation | null> {
    const now = Date.now();
    const skipped = new Set(skip.map(([k, m]) => `${k} ${m}`));
    let reserved: Reservation | null = null;

    for (const model of models) {
      // A model absent from the table has no measured quota -- the console
      // shows it 0/0/0. Routing to it spends a request to be told no.
      if (!MODEL_QUOTAS[model]) continue;

      let best: { row: Row; util: number } | null = null;

      for (const keyId of keyIds) {
        if (skipped.has(`${keyId} ${model}`)) continue;

        const limits = quotaFor(keyId, model);
        if (!limits) continue;

        const row = this.read(keyId, model, now);
        if (row.blocked_until > now) continue;
        if (row.rpm_used + 1 > limits.rpm) continue;
        if (row.rpd_used + 1 > limits.rpd) continue;
        if (row.tpm_used + estTokens > limits.tpm) continue;

        // Infinity in the denominator gives 0, which is correct: a Live model
        // with unlimited RPM/RPD is never the busier choice on those axes.
        const util = Math.max(row.rpm_used / limits.rpm, row.rpd_used / limits.rpd);
        if (!best || util < best.util) best = { row, util };
      }

      if (best) {
        best.row.rpm_used += 1;
        best.row.rpd_used += 1;
        best.row.tpm_used += estTokens;
        this.write(best.row);
        reserved = { keyId: best.row.key_id, model: best.row.model };
        break;
      }
    }

    // Outside the selection loop on purpose: this awaits, and the loop above
    // must not.
    if (reserved) await this.armSweep();
    return reserved;
  }

  /**
   * Replace the token estimate with what Gemini actually billed.
   *
   * Only TPM is corrected. RPM and RPD counted one request, and that is what
   * happened whatever the token count turned out to be.
   */
  async reconcile(
    keyId: string,
    model: string,
    estTokens: number,
    actualTokens: number,
  ): Promise<void> {
    const now = Date.now();
    const row = this.read(keyId, model, now);
    // Clamped at zero: if the minute rolled between the reserve and the
    // response, the estimate was charged to a window that no longer exists and
    // subtracting it would credit this minute for tokens it never spent.
    row.tpm_used = Math.max(0, row.tpm_used - estTokens + actualTokens);
    this.write(row);
  }

  /**
   * Upstream said 429 for a key we believed had headroom -- clock drift, a
   * stale estimate, or traffic against this key from outside this system.
   *
   * ponytail: saturates the minute and blocks for one, without asking which
   * limit was hit. A daily exhaustion therefore costs one wasted request per
   * key per minute to rediscover. The upgrade path is the `RetryInfo` detail on
   * Google's 429 body, which carries a real `retryDelay` -- parse it here and
   * block for exactly that long if those wasted requests ever show up in the
   * usage numbers.
   */
  async markExhausted(keyId: string, model: string): Promise<void> {
    const now = Date.now();
    const row = this.read(keyId, model, now);
    const limits = quotaFor(keyId, model);
    if (limits && Number.isFinite(limits.rpm)) row.rpm_used = limits.rpm;
    row.blocked_until = now + MINUTE;
    this.write(row);
  }

  /** Everything tracked, with limits, for `GET /debug/usage`. */
  async snapshot(): Promise<UsageRow[]> {
    const now = Date.now();
    return this.sql
      .exec<Row>("SELECT * FROM usage ORDER BY key_id, model")
      .toArray()
      .map((raw) => {
        const row = this.roll({ ...raw }, now);
        const limits = quotaFor(row.key_id, row.model);
        return {
          key_id: row.key_id,
          model: row.model,
          rpm_used: row.rpm_used,
          tpm_used: row.tpm_used,
          rpd_used: row.rpd_used,
          blocked_for_ms: Math.max(0, row.blocked_until - now),
          limits: {
            rpm: limits ? finite(limits.rpm) : null,
            tpm: limits ? finite(limits.tpm) : null,
            rpd: limits ? finite(limits.rpd) : null,
          },
        };
      });
  }

  private async armSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 60 * MINUTE);
    }
  }

  /**
   * Hourly sweep. A row whose day-window has expired is fully reset by `roll()`
   * anyway, so this deletes it outright rather than zeroing it -- otherwise
   * every key/model pair ever touched sits in the table forever and
   * `/debug/usage` fills with entries nothing has used in weeks.
   *
   * The alarm re-arms only while rows remain, so an idle broker stops waking.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec("DELETE FROM usage WHERE rpd_win < ? AND blocked_until < ?", now - DAY, now);
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM usage").toArray()[0];
    if ((left?.n ?? 0) > 0) await this.ctx.storage.setAlarm(now + 60 * MINUTE);
  }
}
