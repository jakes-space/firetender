import { z } from "zod";

import { addContextToError, FiretenderUsageError } from "./errors";
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
  QuerySnapshot,
} from "./firestore-deps";
import { FiretenderDoc, FiretenderDocOptions, Patcher } from "./FiretenderDoc";
import { DeepPartial } from "./ts-helpers";

/**
 * A representation of a Firestore collection or subcollection.
 *
 * It represents a given "collection path": the collection names from a document
 * reference, sans IDs.  All docs at /databases/{db}/documents/foo/{*}/bar/{*}
 * are covered by a FiretenderCollection for the path ["foo", "bar"].
 */
export class FiretenderCollection<SchemaType extends z.SomeZodObject> {
  /** Zod schema used to parse and validate the document's data. */
  readonly schema: SchemaType;

  /** Firestore object: the thing you get from getFirestore(). */
  readonly firestore: Firestore;

  /** The collection path of this object: a series of collection names. */
  readonly collectionPath: string[];

  /** Function to return the initial values when creating a new document. */
  private readonly baseInitialDataFactory:
    | (() => DeepPartial<z.input<SchemaType>>)
    | undefined;

  /** Default options to send to docs in this collection. */
  private readonly defaultDocOptions: FiretenderDocOptions;

  /**
   * @param schema the Zod object schema describing the documents in this
   *   collection.
   * @param firestore the thing you get from getFirestore().
   * @param collectionPath the path of this collection in Firestore: the names
   *   of any parent collections and of this collection.
   * @param baseInitialData (optional) an object or object factory providing
   *   default field values for this collection.
   * @param options default optional parameters for the resulting FiretenderDoc;
   *   see FiretenderDocOptions for detail.  Options passed to `.newDoc()` and
   *   `.existingDoc()` override these.
   */
  constructor(
    schema: SchemaType,
    firestore: Firestore,
    collectionPath: [string, ...string[]] | string,
    baseInitialData:
      | (() => DeepPartial<z.input<SchemaType>>)
      | DeepPartial<z.input<SchemaType>>
      | undefined = undefined,
    options: FiretenderDocOptions = {},
  ) {
    this.schema = schema;
    this.firestore = firestore;
    this.collectionPath = [collectionPath].flat();
    if (baseInitialData) {
      if (typeof baseInitialData === "function") {
        this.baseInitialDataFactory = baseInitialData;
      } else {
        this.baseInitialDataFactory = () => baseInitialData;
      }
    }
    this.defaultDocOptions = options;
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
    initialData: DeepPartial<z.input<SchemaType>> | undefined = undefined,
    options: FiretenderDocOptions = {},
  ): FiretenderDoc<SchemaType> {
    const ids = id instanceof Array ? id : id ? [id] : [];
    let ref: DocumentReference | CollectionReference | undefined =
      this.makeDocRefInternal(ids);
    if (!ref) {
      ref = this.makeCollectionRefInternal(ids);
    }
    if (!ref) {
      throw new FiretenderUsageError(
        "newDoc() requires an ID path for all collections and subcollections, except optionally the last.",
      );
    }
    const data = {};
    if (this.baseInitialDataFactory) {
      Object.assign(data, this.baseInitialDataFactory());
    }
    if (initialData) {
      Object.assign(data, initialData);
    }
    return FiretenderDoc.createNewDoc(this.schema, ref, data, {
      ...this.defaultDocOptions,
      ...options,
    });
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
    options: FiretenderDocOptions = {},
  ): FiretenderDoc<SchemaType> {
    const ref = this.makeDocRefInternal([id].flat());
    if (!ref) {
      throw new FiretenderUsageError(
        "existingDoc() requires a full ID path for this collection and its parent collections, if any.",
      );
    }
    return new FiretenderDoc(this.schema, ref, {
      ...this.defaultDocOptions,
      ...options,
    });
  }

  /**
   * Returns an array of all the documents in this collection.
   *
   * If the collection may contain a large number of documents, use query() with
   * the limit() and startAfter() constraints to paginate the results.
   *
   * @param id (optional) when querying a subcollection, the ID(s) of its parent
   *   collection(s).
   */
  async getAllDocs(
    id: string[] | string | undefined = undefined,
  ): Promise<FiretenderDoc<SchemaType>[]> {
    const ids = id instanceof Array ? id : id ? [id] : [];
    const collectionRef = this.makeCollectionRefInternal(ids);
    if (!collectionRef) {
      throw new FiretenderUsageError(
        "When querying a subcollection, getAllDocs() requires the IDs of all parent collections.",
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
  ): Promise<FiretenderDoc<SchemaType>[]> {
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
      this.makeCollectionRefInternal(ids);
    if (!ref) {
      ref = collectionGroup(
        this.firestore,
        this.collectionPath[this.collectionPath.length - 1],
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
    const ref = this.makeDocRefInternal([id].flat());
    if (!ref) {
      throw new FiretenderUsageError(
        "delete() requires the full ID path of the target document.",
      );
    }
    try {
      await deleteDoc(ref);
    } catch (error) {
      addContextToError(error, "deleteDoc", ref);
    }
  }

  /**
   * Returns a document reference for the specified ID.
   *
   * @param id the ID or array of IDs specifying the desired document.
   */
  makeDocRef(id: string[] | string): DocumentReference {
    const ids = [id].flat();
    const ref = this.makeDocRefInternal(ids);
    if (!ref) {
      throw new FiretenderUsageError(
        `Document refs for /${this.collectionPath.join("/*")}/* require ${
          this.collectionPath.length
        } document IDs; received ${ids.length}.`,
      );
    }
    return ref;
  }

  /**
   * Returns a collection reference for the specified ID.
   *
   * @param id the ID or array of IDs specifying the desired collection.
   */
  makeCollectionRef(
    id: string[] | string | undefined = undefined,
  ): CollectionReference {
    const ids = id ? [id].flat() : [];
    const ref = this.makeCollectionRefInternal(ids);
    if (!ref) {
      throw new FiretenderUsageError(
        `Collection refs for /${this.collectionPath.join("/*")} require ${
          this.collectionPath.length - 1
        } document IDs; received ${ids.length}.`,
      );
    }
    return ref;
  }

  /**
   * Convenience method to provide a single patcher function for this
   * collection's documents.  Patchers can also be passed in the options
   * argument of this class's constructor.
   */
  patch(patcher: Patcher): void {
    if (!this.defaultDocOptions.patchers) {
      this.defaultDocOptions.patchers = [patcher];
    } else {
      this.defaultDocOptions.patchers.push(patcher);
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  // Private functions

  /**
   * Builds a doc ref from the given IDs, or returns "undefined" if the IDs do
   * not correctly specify a doc path.
   */
  private makeDocRefInternal(ids: string[]): DocumentReference | undefined {
    if (ids.length !== this.collectionPath.length) {
      return undefined;
    }
    const path = ids.flatMap((id, i) => [this.collectionPath[i], id]);
    return doc(this.firestore, path[0], ...path.slice(1));
  }

  /**
   * Builds a collection ref from the given IDs, or returns "undefined" if the
   * IDs do not correctly specify a collection path.
   */
  private makeCollectionRefInternal(
    ids: string[],
  ): CollectionReference | undefined {
    if (ids.length !== this.collectionPath.length - 1) {
      return undefined;
    }
    const subPath = ids.flatMap((id, i) => [id, this.collectionPath[i + 1]]);
    return collection(this.firestore, this.collectionPath[0], ...subPath);
  }

  /**
   * Executes the given query and returns an array of the results, wrapped in
   * FiretenderDoc objects.
   */
  private async getAndWrapDocs(
    query: CollectionReference | Query,
  ): Promise<FiretenderDoc<SchemaType>[]> {
    let querySnapshot: QuerySnapshot;
    try {
      querySnapshot = await getDocs(query);
    } catch (error) {
      addContextToError(
        error,
        "getDocs",
        query instanceof CollectionReference ? query : undefined,
      );
      throw error;
    }
    return querySnapshot.docs.map(
      (queryDoc) =>
        new FiretenderDoc(this.schema, queryDoc.ref, {
          ...this.defaultDocOptions,
          rawData: queryDoc.data(),
        }),
    );
  }
}
