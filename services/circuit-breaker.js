const { ApiError } = require('./upstream');

class CircuitOpenError extends ApiError {
  constructor(retryAfterSeconds) {
    super(503, 'Event service temporarily unavailable', { dependencyFailure: false });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class CircuitBreaker {
  constructor({ now = () => performance.now(), random = Math.random, onTransition = () => {} } = {}) {
    this.now = now;
    this.random = random;
    this.onTransition = onTransition;
    this.state = 'closed';
    this.failures = [];
    this.generation = 0;
    this.nextDelayMs = 5000;
    this.retryAt = 0;
    this.probeInFlight = false;
  }

  transition(state) {
    const from = this.state;
    this.state = state;
    this.generation++;
    this.onTransition({ from, to: state, retryAfterSeconds: this.retryAfterSeconds() });
  }

  retryAfterSeconds() {
    return this.state === 'open' ? Math.max(1, Math.ceil((this.retryAt - this.now()) / 1000))
      : this.state === 'half-open' ? 1 : 0;
  }

  open(error) {
    const jitteredDelay = Math.min(30000, Math.round(this.nextDelayMs * (0.8 + 0.4 * this.random())));
    this.retryAt = this.now() + Math.min(30000, Math.max(jitteredDelay, error.retryAfterMs || 0));
    this.nextDelayMs = Math.min(30000, this.nextDelayMs * 2);
    this.probeInFlight = false;
    this.transition('open');
  }

  close() {
    this.failures = [];
    this.nextDelayMs = 5000;
    this.probeInFlight = false;
    this.transition('closed');
  }

  async execute(operation) {
    if (this.state === 'open') {
      if (this.now() < this.retryAt) throw new CircuitOpenError(this.retryAfterSeconds());
      this.transition('half-open');
    }
    const probe = this.state === 'half-open';
    if (probe && this.probeInFlight) throw new CircuitOpenError(this.retryAfterSeconds());
    if (probe) this.probeInFlight = true;
    const generation = this.generation;
    try {
      const value = await operation();
      // A late completion from before opening must not reset a newer circuit.
      if (generation === this.generation && probe) this.close();
      return value;
    } catch (error) {
      if (generation !== this.generation) throw error;
      if (!error.dependencyFailure) {
        // Invalid user input isn't evidence that the write service has recovered.
        if (probe) this.probeInFlight = false;
        throw error;
      }
      const now = this.now();
      this.failures = this.failures.filter(time => time >= now - 30000);
      this.failures.push(now);
      if (probe || this.failures.length >= 3) this.open(error);
      throw error;
    }
  }
}

module.exports = { CircuitBreaker, CircuitOpenError };
