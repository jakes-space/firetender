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
 */
export const serverTimestamp = () => firestoreServerTimestamp() as Timestamp;
