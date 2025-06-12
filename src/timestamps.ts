import { z } from "zod";

import { NullTimestampError } from "./errors.js";
import {
  isServerTimestamp,
  serverTimestamp as firestoreServerTimestamp,
  Timestamp,
} from "./firestore-deps.js";

/**
 * Timestamp representation used by Firestore: seconds and nanoseconds since the
 * epoch.
 */
export const timestampSchema = z.custom<Timestamp>((data: any) => {
  if (data === null) {
    throw new NullTimestampError();
  }
  return data instanceof Timestamp || isServerTimestamp(data);
});

/**
 * Timestamp representation used by Firestore: seconds and nanoseconds since the
 * epoch.
 *
 * This schema is for server-generated timestamps, which are null when first
 * reported to the listener.
 */
export const serverTimestampSchema = z.preprocess(
  (data) => data ?? Timestamp.now(),
  timestampSchema,
);

/**
 * Returns a Firestore Timestamp for some future date.  The result is typically
 * used for writing TTLs.
 *
 * The client's clock is used to generate the timestamp.  For TTLs days in the
 * future, this is generally not a concern.  However, this function should not
 * be depended on for short offsets.
 *
 * @param interval how far in the future to set the timestamp.  It can be any
 *   combination of `days`, `hours`, `minutes`, `seconds`, and `millis`.
 *
 * @example const timestamp = futureTimestamp({days: 30});
 */
export function futureTimestamp(interval: {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  millis?: number;
}): Timestamp {
  let utcMillis = Date.now();
  if (interval.days) utcMillis += interval.days * 24 * 60 * 60 * 1000;
  if (interval.hours) utcMillis += interval.hours * 60 * 60 * 1000;
  if (interval.minutes) utcMillis += interval.minutes * 60 * 1000;
  if (interval.seconds) utcMillis += interval.seconds * 1000;
  if (interval.millis) utcMillis += interval.millis;
  return Timestamp.fromMillis(utcMillis);
}

/**
 * Returns a sentinel to include a server-generated timestamp in the written
 * data.
 *
 * Note that the sentinel, despite being typed as a Timestamp, has none of that
 * class's properties or methods.  For a sentinel that can be immediately used
 * as a Timestamp, see {@link serverTimestampWithClientTime}.
 */
export function serverTimestamp(): Timestamp {
  return firestoreServerTimestamp() as Timestamp;
}

/**
 * Returns a sentinel to include a server-generated timestamp in the written
 * data.  The returned object also includes all properties and methods of
 * Timestamp, allowing its immediate use without retrieving the server-set time.
 *
 * Note that the time returned by the Timestamp methods will likely differ from
 * the time set by the server.  It may differ substantially if the client's
 * clock is incorrect.  Caveat coder.
 */
export function serverTimestampWithClientTime(): Timestamp {
  const sentinel = firestoreServerTimestamp();
  const timestamp = Timestamp.now();
  Object.assign(sentinel, timestamp);
  (sentinel as any).isEqual = (other: Timestamp) => timestamp.isEqual(other);
  (sentinel as any).toDate = () => timestamp.toDate();
  (sentinel as any).toMillis = () => timestamp.toMillis();
  (sentinel as any).valueOf = () => timestamp.valueOf();
  // Note: .toJSON() is not polyfilled because it is undocumented
  // (https://firebase.google.com/docs/reference/node/firebase.firestore.Timestamp)
  // and is not present in the firestore-admin Timestamp implementation.
  return sentinel as Timestamp;
}
