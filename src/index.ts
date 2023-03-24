import {
  FiretenderError,
  FiretenderInternalError,
  FiretenderIOError,
  FiretenderUsageError,
} from "./errors";
import { FiretenderCollection } from "./FiretenderCollection";
import type { FiretenderDocOptions } from "./FiretenderDoc";
import { FiretenderDoc } from "./FiretenderDoc";
import {
  futureTimestampDays,
  serverTimestamp,
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
  timestampSchema,
};
