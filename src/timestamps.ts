import {
  serverTimestamp as firestoreServerTimestamp,
  Timestamp,
} from "firebase/firestore";
import { z } from "zod";

/**
 * Timestamp representation used by Firestore: seconds and nanoseconds since the
 * epoch.
 */
export const timestampSchema = z.custom<Timestamp>(
  (data: any) =>
    data instanceof Timestamp || data._methodName === "serverTimestamp"
);

/**
 * Returns a Firestore Timestamp for some future date.  The result is typically
 * used for writing TTLs.
 *
 * The client's clock (specifically `Date.now()`) is used to generate the
 * timestamp.  For TTLs days in the future, this is generally not a concern.
 * However, this function should not be depended on for short offsets.
 *
 * @param daysFromNow days in the future to set this Timestamp.
 */
export function futureTimestampDays(daysFromNow: number) {
  return Timestamp.fromMillis(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
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
  (sentinel as any).toJSON = () => timestamp.toJSON();
  (sentinel as any).toMillis = () => timestamp.toMillis();
  (sentinel as any).toString = () => timestamp.toString();
  (sentinel as any).valueOf = () => timestamp.valueOf();
  return sentinel as Timestamp;
}
