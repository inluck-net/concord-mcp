/** An answer a hub handler decided on: an HTTP status and a JSON body. */
export interface HubOutcome {
  readonly status: number;
  readonly body: object;
}

export function ok(body: object): HubOutcome {
  return { status: 200, body };
}

export function badRequest(error: string): HubOutcome {
  return { status: 400, body: { error } };
}

export function payloadTooLarge(): HubOutcome {
  return { status: 413, body: { error: 'payload too large' } };
}

export function unauthorized(): HubOutcome {
  return { status: 401, body: { error: 'unauthorized' } };
}

export function forbidden(error: string): HubOutcome {
  return { status: 403, body: { error } };
}

export function notFound(error = 'not found'): HubOutcome {
  return { status: 404, body: { error } };
}

export function methodNotAllowed(): HubOutcome {
  return { status: 405, body: { error: 'method not allowed' } };
}

export function conflict(error: string): HubOutcome {
  return { status: 409, body: { error } };
}
