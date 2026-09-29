// Shape checks that let a route answer a real HTTP 404 on the server before rendering (audit P2-8: both
// /coding/nope and /workspaces/nope came back 200 with an empty-looking page). They only reject ids that
// could never exist; an id with the right shape but no record still gets the page's own "not found" view.

/** A coding job id is a UUID (scripts/coding/routes.ts matches the same shape). */
export const isJobIdShape = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * An older /workspaces/<project folder> link: the key is a folder path with its separators turned into
 * hyphens, so it always contains one. The three workspace ids (no hyphen) are checked separately.
 */
export const isFolderKeyShape = (id: string) => /^[\w.-]{3,200}$/.test(id) && id.includes("-");
