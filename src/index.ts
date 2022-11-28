import { FiretenderCollection } from "./FiretenderCollection";
import type { FiretenderDocOptions } from "./FiretenderDoc";
import { FiretenderDoc } from "./FiretenderDoc";

export { FiretenderCollection, FiretenderDoc, FiretenderDocOptions };

// TODO #6, #9, #10: stop using a direct export after the timestamp module gets
// cleaned up.
export * from "./Timestamps";
