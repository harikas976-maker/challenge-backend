class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createUpstreamClient({ timeoutMs = 2000 } = {}) {
  return async function upstream(path, options = {}) {
    try {
      const response = await fetch(`http://event.com${path}`, {
        ...options, signal: AbortSignal.timeout(timeoutMs)
      });
      // Error bodies may be empty or contain internal stack traces.
      if (!response.ok) {
        if (response.status === 404) throw new ApiError(404, 'Resource not found');
        if (response.status === 503 || response.status === 429) {
          throw new ApiError(503, 'Event service temporarily unavailable');
        }
        throw new ApiError(502, 'Event service request failed');
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
