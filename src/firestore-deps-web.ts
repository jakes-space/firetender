/**
 * Provides all dependencies normally imported from "firebase/firestore".
 *
 * For web clients, the "firebase/firestore" API is simply re-exported.
 */

import { DocumentReference, DocumentSnapshot } from "firebase/firestore";

export type { Unsubscribe } from "firebase/firestore";
export {
  addDoc,
  collection,
  collectionGroup,
  CollectionReference,
  deleteDoc,
  deleteField,
  doc,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  getDoc,
  getDocs,
  onSnapshot,
  Query,
  query,
  QueryConstraint,
  QuerySnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";

export const FIRESTORE_DEPS_TYPE: "web" | "admin" = "web";

// DocumentSnapshot.prototype.exists is a function for "firebase/firestore" and
// a boolean for "firebase-admin/firestore".
export const snapshotExists = (snapshot: DocumentSnapshot): boolean =>
  snapshot.exists();

export const isServerTimestamp = (data: any): boolean =>
  data?._methodName === "serverTimestamp";

export const isDocRef = (ref: any): ref is DocumentReference =>
  ref && typeof ref === "object" && ref.type === "document";
