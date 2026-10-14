// Errors thrown by the network layer. Connectors catch these to update their
// health state; none of them is ever retried automatically except
// RateLimitedError after its retryAt time.

export class ForbiddenHostError extends Error {
  override readonly name = 'ForbiddenHostError';
  constructor(readonly url: string, readonly reason: string) {
    super(`Blocked by network policy: ${reason}`);
  }
}

export class NetworkPausedError extends Error {
  override readonly name = 'NetworkPausedError';
  constructor() {
    super('Network is paused');
  }
}

/** The host served a challenge page or rejected our credentials; disabled until the user re-enables it. */
export class HostBlockedError extends Error {
  override readonly name = 'HostBlockedError';
  constructor(readonly host: string, readonly reason: string) {
    super(`${host} disabled: ${reason}`);
  }
}

export class RateLimitedError extends Error {
  override readonly name = 'RateLimitedError';
  constructor(readonly budget: string, readonly retryAt: number) {
    super(`Rate limit for ${budget}; next slot at ${new Date(retryAt).toISOString()}`);
  }
}

export class HttpStatusError extends Error {
  override readonly name = 'HttpStatusError';
  constructor(readonly status: number, readonly url: string, readonly body: string | null) {
    super(`HTTP ${status}`);
  }
}

export class HttpTimeoutError extends Error {
  override readonly name = 'HttpTimeoutError';
  constructor(readonly url: string) {
    super('Request timed out');
  }
}
