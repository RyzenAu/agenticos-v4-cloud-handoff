/** Errors that carry their HTTP meaning to a route's catch-all (Audit F5 P3). No imports: any module can throw them. */

/** The request body is over the limit: 413. */
export class PayloadTooLarge extends Error {}

/** A local service the route needs (Hermes, a worker, a store) is not running: 503, not 400. */
export class ServiceUnavailable extends Error {}
