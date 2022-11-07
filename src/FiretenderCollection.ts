import {
  collection,
  CollectionReference,
  doc,
  DocumentReference,
  Firestore,
} from "firebase/firestore";
import { z } from "zod";

import { FiretenderDoc, FiretenderDocOptions } from "./FiretenderDoc";

export class FiretenderCollection<
  SchemaType extends z.SomeZodObject,
  InputType extends { [x: string]: any } = z.input<SchemaType>
> {
  readonly schema: SchemaType;
  readonly firestore: Firestore;
  readonly collectionNames: string[];
  readonly baseInitialData: InputType;

  constructor(
    schema: SchemaType,
    collectionPath: [Firestore, ...string[]],
    baseInitialData: InputType
  ) {
    this.schema = schema;
    this.firestore = collectionPath[0];
    this.collectionNames = collectionPath.slice(1) as string[];
    this.baseInitialData = baseInitialData;
  }

  createNewDoc(
    id: string[] | string | undefined = undefined,
    initialData: InputType | undefined = undefined,
    options: FiretenderDocOptions = {}
  ) {
    const ids = id instanceof Array ? id : id ? [id] : [];
    let ref: DocumentReference | CollectionReference | undefined =
      this.makeDocRef(ids);
    if (!ref) {
      ref = this.makeCollectionRef(ids);
    }
    if (!ref) {
      throw Error("wrong number of ID entries"); // TODO
    }
    const data = this.baseInitialData;
    if (initialData) {
      Object.assign(data, initialData);
    }
    return FiretenderDoc.createNewDoc(this.schema, ref, data, options);
  }

  wrapExistingDoc(id: string[] | string, options: FiretenderDocOptions = {}) {
    const ref = this.makeDocRef([id].flat());
    if (!ref) {
      throw Error("wrong number of ID entries"); // TODO
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
