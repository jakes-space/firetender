export class FiretenderError extends Error {}

/**
 * Something went wrong with a Firestore operation, such as trying to load a
 * document that does not exist.
 */
export class FiretenderIOError extends FiretenderError {}

/**
 * The caller did something wrong: a function was called at the wrong time or
 * with the wrong parameters.
 */
export class FiretenderUsageError extends FiretenderError {}

/**
 * Something went wrong internally.  These errors indicate a bug in Firetender.
 */
export class FiretenderInternalError extends FiretenderError {}
