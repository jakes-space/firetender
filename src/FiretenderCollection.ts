import {
  collection,
  CollectionReference,
  doc,
  DocumentReference,
  Firestore,
} from "firebase/firestore";
import { z } from "zod";

import { FiretenderDoc, FiretenderDocOptions } from "./FiretenderDoc";
import { DeepPartial } from "./ts-helpers";

export class FiretenderCollection<SchemaType extends z.SomeZodObject> {
  readonly schema: SchemaType;
  readonly firestore: Firestore;
  readonly collectionNames: string[];
  readonly baseInitialData: DeepPartial<z.infer<SchemaType>>;

  constructor(
    schema: SchemaType,
    collectionPath: [Firestore, ...string[]],
    baseInitialData: DeepPartial<z.infer<SchemaType>>
  ) {
    this.schema = schema;
    this.firestore = collectionPath[0];
    this.collectionNames = collectionPath.slice(1) as string[];
    this.baseInitialData = baseInitialData;
  }

  createNewDoc(
    id: string[] | string | undefined = undefined,
    initialData: DeepPartial<z.infer<SchemaType>> | undefined = undefined,
    options: FiretenderDocOptions = {}
  ) {
    const ids = id instanceof Array ? id : id ? [id] : [];
    let ref: DocumentReference | CollectionReference | undefined =
      this.makeDocRef(ids);
    if (!ref) {
      ref = this.makeCollectionRef(ids);
    }
    if (!ref) {
      throw Error(
        "createNewDoc() requires an ID for all collections and subcollections except the last."
      );
    }
    const data = this.baseInitialData;
    if (initialData) {
      Object.assign(data, initialData);
    }
    return FiretenderDoc.createNewDoc(this.schema, ref, data, options);
  }

  getExistingDoc(id: string[] | string, options: FiretenderDocOptions = {}) {
    const ref = this.makeDocRef([id].flat());
    if (!ref) {
      throw Error(
        "getExistingDoc() requires an ID for the collection and IDs for each of its subcollections (if any)."
      );
    }
    return new FiretenderDoc(this.schema, ref, options);
  }

  private makeDocRef(ids: string[]): DocumentReference | undefined {
    if (ids.length !== this.collectionNames.length) {
      return undefined;
    }
    const path = ids.flatMap((id, i) => [this.collectionNames[i], id]);
    return doc(this.firestore, path[0], ...path.slice(1));
  }

  private makeCollectionRef(ids: string[]): CollectionReference | undefined {
    if (ids.length !== this.collectionNames.length - 1) {
      return undefined;
    }
    const subPath = ids.flatMap((id, i) => [id, this.collectionNames[i + 1]]);
    return collection(this.firestore, this.collectionNames[0], ...subPath);
  }
}
