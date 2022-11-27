import {
  collection,
  collectionGroup,
  CollectionReference,
  deleteDoc,
  doc,
  DocumentReference,
  Firestore,
  getDocs,
  Query,
  query,
  QueryConstraint,
} from "firebase/firestore";
import { z } from "zod";

import { FiretenderDoc, PublicFiretenderDocOptions } from "./FiretenderDoc";
import { DeepPartial } from "./ts-helpers";

/**
 * A representation of a Firestore collection or subcollection.
 */
export class FiretenderCollection<
  SchemaType extends z.SomeZodObject,
  DataType extends z.infer<SchemaType> = z.infer<SchemaType>,
  InputType extends z.input<SchemaType> = z.input<SchemaType>
> {
  readonly schema: SchemaType;
  readonly firestore: Firestore;
  readonly collectionNames: string[];
  readonly baseInitialData: DeepPartial<InputType> | undefined;

  /**
   * @param schema the Zod object schema describing the documents in this
   *   collection.
   * @param collectionPath the path of this collection in Firestore.  The first
   *   entry must be a Firestore object, followed by the names of any parent
   *   collections and of this collection.
   * @param baseInitialData (optional) default field values for this collection.
   */
  constructor(
    schema: SchemaType,
    collectionPath: [Firestore, ...string[]],
    baseInitialData: DeepPartial<z.input<SchemaType>> | undefined = undefined
  ) {
    this.schema = schema;
    this.firestore = collectionPath[0];
    this.collectionNames = collectionPath.slice(1) as string[];
    if (baseInitialData) {
      this.baseInitialData = baseInitialData;
    }
  }

  /**
   * Returns a FiretenderDoc representing a new document in this collection.
   *
   * This method initializes the FiretenderDoc but does not create it in
   * Firestore.  To do so, call the doc's write() method.
   *
   * @param id the ID or array of IDs giving the path of the new document.
   *   Firestore will generate a random doc ID if it is omitted.  If this is a
   *   subcollection, the ID(s) for the parent collection(s) are required.
   * @param initialData the document's initial data, which is merged with (and
   *   potentially overwrites) field values specified in the constructor.
   * @param options optional parameters for the resulting FiretenderDoc; see
   *   FiretenderDocOptions for detail.
   */
  newDoc(
    id: string[] | string | undefined = undefined,
    initialData: DeepPartial<InputType> | undefined = undefined,
    options: PublicFiretenderDocOptions = {}
  ): FiretenderDoc<SchemaType, DataType> {
    const ids = id instanceof Array ? id : id ? [id] : [];
    let ref: DocumentReference | CollectionReference | undefined =
      this.makeDocRef(ids);
    if (!ref) {
      ref = this.makeCollectionRef(ids);
    }
    if (!ref) {
      throw Error(
        "newDoc() requires an ID path for all collections and subcollections, except optionally the last."
      );
    }
    const data = {};
    if (this.baseInitialData) {
      Object.assign(data, this.baseInitialData);
    }
    if (initialData) {
      Object.assign(data, initialData);
    }
    return FiretenderDoc.createNewDoc(this.schema, ref, data, options);
  }

  /**
   * Returns a FiretenderDoc representing an existing Firestore document in this
   * collection.
   *
   * This method initializes the FiretenderDoc but does not load its data.  If
   * the doc does not exist in Firestore, calling load() will throw an error.
   *
   * @param id the ID or array of IDs specifying the desired document.
   * @param options optional parameters for the resulting FiretenderDoc; see
   *   FiretenderDocOptions for detail.
   */
  existingDoc(
    id: string[] | string,
    options: PublicFiretenderDocOptions = {}
  ): FiretenderDoc<SchemaType, DataType> {
    const ref = this.makeDocRef([id].flat());
    if (!ref) {
      throw Error(
        "existingDoc() requires a full ID path for this collection and its parent collections, if any."
      );
    }
    return new FiretenderDoc(this.schema, ref, options);
  }

  /**
   * Returns an array of all the documents in this collection.
   *
   * If the collection may contain a large number of documents, use query() with
   * the limit() and startAfter() contraints to paginate the results.
   *
   * @param id (optional) when querying a subcollection, the ID(s) of its parent
   *   collection(s).
   */
  async getAllDocs(
    id: string[] | string | undefined = undefined
  ): Promise<FiretenderDoc<SchemaType, DataType>[]> {
    const ids = id instanceof Array ? id : id ? [id] : [];
    const collectionRef = this.makeCollectionRef(ids);
    if (!collectionRef) {
      throw Error(
        "When querying a subcollection, getAllDocs() requires the IDs of all parent collections."
      );
    }
    return this.getAndWrapDocs(collectionRef);
  }

  /**
   * Returns an array of the documents matching the given query.
   *
   * @param id (optional) when querying a subcollection, the ID(s) of its parent
   *   collection(s); omit when querying a top-level collection or when querying
   *   all docs in this subcollection, regardless of parent.
   * @param ...whereClauses the where(), limit(), orderBy(), startAfter(), etc.
   *   constraints defining this query.
   */
  async query(
    idOrWhereClause: string | string[] | QueryConstraint,
    ...moreWhereClauses: QueryConstraint[]
  ): Promise<FiretenderDoc<SchemaType, DataType>[]> {
    let ids: string[];
    let whereClauses: QueryConstraint[];
    if (idOrWhereClause instanceof Array) {
      ids = idOrWhereClause;
      whereClauses = moreWhereClauses;
    } else if (typeof idOrWhereClause === "string") {
      ids = [idOrWhereClause];
      whereClauses = moreWhereClauses;
    } else {
      ids = [];
      whereClauses = [idOrWhereClause, ...moreWhereClauses];
    }
    let ref: CollectionReference | Query | undefined =
      this.makeCollectionRef(ids);
    if (!ref) {
      ref = collectionGroup(
        this.firestore,
        this.collectionNames[this.collectionNames.length - 1]
      );
    }
    return this.getAndWrapDocs(query(ref, ...whereClauses));
  }

  /**
   * Deletes the given document from this collection.
   *
   * The document's subcollections (if any) are not deleted.  To delete them,
   * first use query() to get its subcollection docs, then call delete() on each
   * one.  Please note that the Firestore guide recommends only performing such
   * unbounded batched deletions from a trusted server environment.
   *
   * @param id full path ID of the target document.
   */
  async delete(id: string[] | string): Promise<void> {
    const ref = this.makeDocRef([id].flat());
    if (!ref) {
      throw Error("delete() requires the full ID path of the target document.");
    }
    await deleteDoc(ref);
  }

  //////////////////////////////////////////////////////////////////////////////
  // Private functions

  /**
   * Builds a doc ref from the given IDs, or returns "undefined" if the IDs do
   * not correctly specify a doc path.
   */
  private makeDocRef(ids: string[]): DocumentReference | undefined {
    if (ids.length !== this.collectionNames.length) {
      return undefined;
    }
    const path = ids.flatMap((id, i) => [this.collectionNames[i], id]);
    return doc(this.firestore, path[0], ...path.slice(1));
  }

  /**
   * Builds a collection ref from the given IDs, or returns "undefined" if the
   * IDs do not correctly specify a collection path.
   */
  private makeCollectionRef(ids: string[]): CollectionReference | undefined {
    if (ids.length !== this.collectionNames.length - 1) {
      return undefined;
    }
    const subPath = ids.flatMap((id, i) => [id, this.collectionNames[i + 1]]);
    return collection(this.firestore, this.collectionNames[0], ...subPath);
  }

  /**
   * Executes the given query and returns an array of the results, wrapped in
   * FiretenderDoc objects.
   */
  private async getAndWrapDocs(
    query: CollectionReference | Query
  ): Promise<FiretenderDoc<SchemaType, DataType>[]> {
    const querySnapshot = await getDocs(query);
    return querySnapshot.docs.map(
      (queryDoc) =>
        new FiretenderDoc(this.schema, queryDoc.ref, {
          initialData: queryDoc.data(),
        })
    );
  }
}
