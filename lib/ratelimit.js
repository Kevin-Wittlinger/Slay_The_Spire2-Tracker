// Fixed-window rate limiter stored in the database, so limits hold across
// serverless instances (Vercel) as well as on the local server.

const CLEANUP_CHANCE = 0.02;
const KEEP_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// On Vercel the platform sets x-forwarded-for, so its first entry is the client.
// Locally the header is client-controlled, so only the socket address is trusted.
function clientIp(req) {
  if (process.env.VERCEL) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || "local";
}

function createRateLimiter(db) {
  // Counts one attempt against `key`. Throws HttpError(429) once `max` is exceeded.
  async function hit(key, max, windowMs, message) {
    const now = Date.now();
    const cutoff = now - windowMs;
    let row;
    try {
      const result = await db.execute({
        sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT(key) DO UPDATE SET
            count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
            window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
          RETURNING count, window_start`,
        args: [key, now, cutoff, cutoff, now],
      });
      row = result.rows[0];
    } catch (error) {
      // Never take the site down because the limiter itself failed.
      console.error("Rate limiter error:", error.message);
      return;
    }
    if (Math.random() < CLEANUP_CHANCE) {
      db.execute({
        sql: "DELETE FROM rate_limits WHERE window_start < ?",
        args: [now - KEEP_MS],
      }).catch(() => {});
    }
    if (Number(row.count) > max) {
      const retryAfter = Math.max(
        1,
        Math.ceil((Number(row.window_start) + windowMs - now) / 1000),
      );
      const minutes = Math.ceil(retryAfter / 60);
      throw new HttpError(
        429,
        `${message || "Too many requests."} Try again in ${
          retryAfter > 90 ? `${minutes} minutes` : `${retryAfter} seconds`
        }.`,
        { "Retry-After": String(retryAfter) },
      );
    }
  }

  async function reset(key) {
    await db
      .execute({ sql: "DELETE FROM rate_limits WHERE key = ?", args: [key] })
      .catch(() => {});
  }

  return { hit, reset };
}

module.exports = { HttpError, clientIp, createRateLimiter };
