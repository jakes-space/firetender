import { CollectionReference, DocumentReference } from "./firestore-deps.js";

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

/**
 * Thrown to signal that a `timestampSchema` field was set to null.  This
 * happens when listening to a timestamp being set to the server time.  See
 * https://stackoverflow.com/questions/64287252/ for background.
 *
 * This error is only used internally.
 */
export class NullTimestampError extends FiretenderError {}

/**
 * Adds a "firetenderContext" property to the given error.
 *
 * @param error the error to which the context is added.  If `error` is not an
 *   object, this call does not modify it.
 * @param call the name of the Firestore function in which the error occurred.
 * @param ref the path of the target document or collection, if any.
 * @param data arbitrary data associated with this call.
 */
export function addContextToError(
  error: any,
  call: string,
  ref?: DocumentReference | CollectionReference,
  data?: any,
): void {
  if (typeof error !== "object") {
    return;
  }
  error.firetenderContext = { call };
  if (ref) {
    error.firetenderContext.ref = ref.path;
  }
  if (data !== undefined) {
    error.firetenderContext.data = data;
  }
}
