class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.statusCode = statusCode;
    this.dependencyFailure = options.dependencyFailure ?? (statusCode >= 500);
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfterMs = options.retryAfterMs ?? 0;
  }
}

function createUpstreamClient({ timeoutMs = 2000 } = {}) {
  return async function upstream(path, options = {}) {
    const { timeoutMs: requestTimeoutMs = timeoutMs, ...fetchOptions } = options;
    try {
      const response = await fetch(`http://event.com${path}`, {
        ...fetchOptions, signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, requestTimeoutMs)))
      });
      // Error bodies may be empty or contain internal stack traces.
      if (!response.ok) {
        const retryAfter = response.headers.get('Retry-After');
        const retryAfterMs = retryAfter == null ? 0 : /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        const details = {
          upstreamStatus: response.status,
          dependencyFailure: response.status >= 500 || response.status === 429,
          retryAfterMs: Number.isFinite(retryAfterMs) ? Math.min(30000, Math.max(0, retryAfterMs)) : 0
        };
        // Cancellation of a tee'd/intercepted stream may wait for its other reader.
        // Release our reader without delaying the status-based error response.
        response.body?.cancel().catch(() => {});
        if (response.status === 404) throw new ApiError(404, 'Resource not found', details);
        if (response.status === 409) throw new ApiError(409, 'Idempotency key already used with a different payload', details);
        if (response.status === 503 || response.status === 429) {
          throw new ApiError(503, 'Event service temporarily unavailable', details);
        }
        throw new ApiError(502, 'Event service request failed', details);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new ApiError(504, 'Event service timed out');
      }
      throw new ApiError(502, 'Invalid response from event service');
    }
  };
}
module.exports = { ApiError, createUpstreamClient };
