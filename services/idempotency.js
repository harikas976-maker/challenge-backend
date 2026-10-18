const { createHash } = require('node:crypto');
const { ApiError } = require('./upstream');

function eventFingerprint({ name, userId, details }) {
  return createHash('sha256').update(JSON.stringify({ name, userId: String(userId), details })).digest('hex');
}

class IdempotencyStore {
  constructor({ now = () => performance.now(), ttlMs = 600000, maxEntries = 10000, createContext = () => ({}) } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.createContext = createContext;
    this.entries = new Map();
  }

  async execute(key, fingerprint, operation) {
    const now = this.now();
    for (const [storedKey, entry] of this.entries) {
      if (!entry.pending && entry.expiresAt <= now) this.entries.delete(storedKey);
    }
    let entry = this.entries.get(key);
    if (entry && entry.fingerprint !== fingerprint) {
      throw new ApiError(409, 'Idempotency key already used with a different payload');
    }
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        const error = new ApiError(503, 'Idempotency capacity temporarily exhausted', { dependencyFailure: false });
        error.retryAfterSeconds = 1;
        throw error;
      }
      entry = { fingerprint, context: this.createContext(), expiresAt: now + this.ttlMs, pending: false };
      this.entries.set(key, entry);
    }
    // Coalesce concurrent callers and cache success. A failure may be attempted
    // again with the same context; an uncertain write must retain its event ID.
    if (!entry.promise) {
      entry.pending = true;
      entry.promise = Promise.resolve().then(() => operation(entry.context)).catch(error => {
        // An upstream conflict means this process did not reserve the real key.
        // Don't let a failed payload mask the upstream's original successful one.
        if (error.statusCode === 409) this.entries.delete(key);
        else entry.promise = undefined;
        throw error;
      }).finally(() => { entry.pending = false; });
    }
    return entry.promise;
  }
}

module.exports = { IdempotencyStore, eventFingerprint };
