import {
  FiretenderError,
  FiretenderInternalError,
  FiretenderIOError,
  FiretenderUsageError,
} from "./errors";
import { Timestamp, where } from "./firestore-deps";
import { FiretenderCollection } from "./FiretenderCollection";
import type { FiretenderDocOptions } from "./FiretenderDoc";
import { FiretenderDoc } from "./FiretenderDoc";
import {
  futureTimestampDays,
  serverTimestamp,
  serverTimestampWithClientTime,
  timestampSchema,
} from "./timestamps";

export {
  FiretenderCollection,
  FiretenderDoc,
  FiretenderDocOptions,
  FiretenderError,
  FiretenderInternalError,
  FiretenderIOError,
  FiretenderUsageError,
  futureTimestampDays,
  serverTimestamp,
  serverTimestampWithClientTime,
  Timestamp,
  timestampSchema,
  where,
};
