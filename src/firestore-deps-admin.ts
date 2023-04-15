/**
 * Provides all dependencies normally imported from "firebase/firestore".
 *
 * For web clients, the "firebase/firestore" API is simply re-exported.
 *
 * For the server client API, ...
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
export const where = Filter.where;
export const arrayRemove = FieldValue.arrayRemove;
export const deleteField = FieldValue.delete;
export const serverTimestamp = FieldValue.serverTimestamp;

export const isServerTimestamp = (x: any) => x instanceof FieldValue;

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
