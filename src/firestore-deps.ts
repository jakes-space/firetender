/**
 * Provides all dependencies normally imported from "firebase/firestore".
 *
 * For web clients, the "firebase/firestore" API is simply re-exported.
 */

import { DocumentSnapshot } from "firebase/firestore";

export * from "firebase/firestore";

export const FIRESTORE_DEPS_TYPE: "web" | "admin" = "web";

// DocumentSnapshot.prototype.exists is a function for "firebase/firestore" and
// a boolean for "firebase-admin/firestore".
export const snapshotExists = (snapshot: DocumentSnapshot) => snapshot.exists();

export const isServerTimestamp = (data: any) =>
  data && data._methodName === "serverTimestamp";
