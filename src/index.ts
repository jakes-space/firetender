import {
  FiretenderError,
  FiretenderInternalError,
  FiretenderIOError,
  FiretenderUsageError,
} from "./errors";
import { FiretenderCollection } from "./FiretenderCollection";
import type { FiretenderDocOptions } from "./FiretenderDoc";
import { FiretenderDoc } from "./FiretenderDoc";

export {
  FiretenderCollection,
  FiretenderDoc,
  FiretenderDocOptions,
  FiretenderError,
  FiretenderInternalError,
  FiretenderIOError,
  FiretenderUsageError,
};

// TODO #6, #9, #10: stop using a direct export after the timestamp module gets
// cleaned up.
export * from "./timestamps";
