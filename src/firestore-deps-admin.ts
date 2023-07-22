/**
 * Provides all dependencies normally imported from "firebase/firestore".
 *
 * For the server client API, we need to wrap the namespaced calls so they are
 * compatible with the v9 modular calls used by the web version.
 */

import {
  CollectionGroup,
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
  Filter,
  Firestore,
  Query,
  QuerySnapshot,
  Timestamp,
  UpdateData,
  WithFieldValue,
} from "@google-cloud/firestore";

export const FIRESTORE_DEPS_TYPE: "web" | "admin" = "admin";

export {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Timestamp,
};

export type QueryConstraint = Filter;
export type Unsubscribe = () => void;
export const where = Filter.where;
export const arrayRemove = FieldValue.arrayRemove;
export const deleteField = FieldValue.delete;
export const serverTimestamp = FieldValue.serverTimestamp;

export const isServerTimestamp = (x: any): boolean => x instanceof FieldValue;

// DocumentSnapshot.prototype.exists is a function for "firebase/firestore" and
// a boolean for "firebase-admin/firestore".
export const snapshotExists = (snapshot: DocumentSnapshot): boolean =>
  snapshot.exists;

export const addDoc = <T>(
  ref: CollectionReference<T>,
  data: WithFieldValue<T>
): Promise<DocumentReference<T>> => ref.add(data);

export const collection = (
  firestoreOrRef: Firestore | CollectionReference,
  path: string,
  ...pathSegments: string[]
): CollectionReference =>
  firestoreOrRef instanceof Firestore
    ? firestoreOrRef.collection([path, ...pathSegments].join("/"))
    : firestoreOrRef.firestore.collection(
        [firestoreOrRef.path, path, ...pathSegments].join("/")
      );

export const collectionGroup = (
  firestore: Firestore,
  collectionID: string
): CollectionGroup => firestore.collectionGroup(collectionID);

export const deleteDoc = async (
  ref: DocumentReference<unknown>
): Promise<void> => {
  await ref.delete();
};

export const doc = (
  firestoreOrRef: Firestore | CollectionReference,
  path?: string,
  ...pathSegments: string[]
): DocumentReference =>
  firestoreOrRef instanceof Firestore
    ? firestoreOrRef.doc([path, ...pathSegments].join("/"))
    : path
    ? firestoreOrRef.doc([path, ...pathSegments].join("/"))
    : firestoreOrRef.doc();

export const getDoc = <T>(
  ref: DocumentReference<T>
): Promise<DocumentSnapshot<T>> => ref.get();

export const getDocs = <T>(query: Query<T>): Promise<QuerySnapshot<T>> =>
  query.get();

export const onSnapshot = (
  ref: DocumentReference,
  callback: (snapshot: DocumentSnapshot) => void
): Unsubscribe => {
  return ref.onSnapshot(callback);
};

export const query = <T>(
  ref: Query<T>,
  ...queryConstraints: QueryConstraint[]
): Query<T> =>
  queryConstraints.length === 0
    ? ref
    : queryConstraints.length === 1
    ? ref.where(queryConstraints[0])
    : ref.where(Filter.and(...queryConstraints));

export const setDoc = async <T>(
  ref: DocumentReference<T>,
  data: WithFieldValue<T>
): Promise<void> => {
  await ref.set(data);
};

export const updateDoc = async <T>(
  ref: DocumentReference<T>,
  data: UpdateData<T>
): Promise<void> => {
  await ref.update(data);
};
