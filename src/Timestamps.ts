import { z } from "zod";

/**
 * Timestamp representation used by Firestore: seconds and nanoseconds since the
 * epoch.
 */
export const timestampSchema = z.object({
  seconds: z.number().positive().int(),
  nanoseconds: z.number().nonnegative().int(),
});
export type TimestampData = z.infer<typeof timestampSchema>;

export function dateFromTimestamp(timestamp: TimestampData): Date {
  return new Date(timestamp.seconds * 1e3 + timestamp.nanoseconds / 1e6);
}

export function makeTTL(daysFromNow = 30) {
  // TODO: #10 is there a way to use the server time rather than Date.now()?
  return timestampFromUnixMillis(
    Date.now() + daysFromNow * 24 * 60 * 60 * 1000
  );
}

export function timestampFromDate(date: Date): TimestampData {
  return timestampFromUnixMillis(date.getTime());
}

export function timestampFromUnixMillis(msSinceEpoch: number): TimestampData {
  return {
    seconds: Math.floor(msSinceEpoch / 1000),
    nanoseconds: Math.floor((msSinceEpoch % 1000) * 1000000),
  };
}

export function nowTimestamp() {
  // TODO: #9 is there a way to use the server time rather than Date.now()?
  return timestampFromUnixMillis(Date.now());
}
