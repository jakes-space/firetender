import {
  FiretenderError,
  FiretenderInternalError,
  FiretenderIOError,
  FiretenderUsageError,
} from "./errors";
import { FirestoreError, Timestamp, where } from "./firestore-deps";
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
  FirestoreError,
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
