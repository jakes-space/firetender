import { z } from "zod";

import {
  addContextToError,
  FiretenderInternalError,
  FiretenderIOError,
  FiretenderUsageError,
} from "./errors";
import {
  addDoc,
  collection,
  CollectionReference,
  doc,
  DocumentReference,
  DocumentSnapshot,
  getDoc,
  onSnapshot,
  setDoc,
  snapshotExists,
  Unsubscribe,
  updateDoc,
} from "./firestore-deps";
import { watchForChanges } from "./proxy";
import { DeepReadonly } from "./ts-helpers";

/**
 * Public options for initializing a FiretenderDoc object.
 *
 * These will be added as needed (e.g., "readonly" for issue #1, possibly
 * "queryPageLength" for issue #21).
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type FiretenderDocOptions = {};

/**
 * All options when initializing a FiretenderDoc object.
 *
 * This type includes options meant for internal use (createDoc, initialData)
 * as well as the options in FiretenderDocOptions.
 */
export type AllFiretenderDocOptions = FiretenderDocOptions & {
  /**
   * Does this FiretenderDoc represent a new document in Firestore?
   */
  createDoc?: true;

  /**
   * The document's initial data, which must define a valid instance of the
   * document according to its schema.
   */
  initialData?: Record<string, any>;
};

/**
 * Options for loading an existing document.
 */
export type LoadOptions<FiretenderDocType> = {
  /**
   * Force a read from Firestore.  Normally load() does nothing if the document
   * already contains data.
   */
  force?: boolean;

  /**
   * Listen for changes to the document.
   *
   * If set to `true`, the document's data will be silently updated when the
   * data on Firestore changes.
   *
   * If set to a callback function, the data will be updated, then the function
   * will be called.  This function is only called on updates; it is not called
   * during the initial load.
   *
   * Remote changes are ignored if local updates are pending.  Assuming the
   * local change does not overwrite them, the remote changes will be picked up
   * when the write triggers the callback.
   */
  listen?:
    | boolean
    | ((doc: FiretenderDocType, snapshot: DocumentSnapshot) => void);
};

/**
 * A local representation of a Firestore document.
 */
export class FiretenderDoc<SchemaType extends z.SomeZodObject> {
  /** Zod schema used to parse and validate the document's data */
  readonly schema: SchemaType;

  /** Firestore reference to this doc, or collection in which to create it */
  private ref: DocumentReference | CollectionReference;

  /** Firestore document ID; undefined for new docs not yet on Firestore */
  private docID: string | undefined = undefined;

  /** Is this a doc we presume does not yet exist in Firestore? */
  private isNewDoc: boolean;

  /** Use addDoc or setDoc to write all the data?  If not, use updateDoc. */
  private isSettingNewContents: boolean;

  /** Local copy of the document data, parsed into the Zod type */
  private data: z.infer<SchemaType> | undefined = undefined;

  /** Proxy to intercept write (.w) access to the data and track the changes */
  private dataProxy: ProxyHandler<z.infer<SchemaType>> | undefined = undefined;

  /** Map from the dot-delimited field path (per updateDoc()) to new value */
  private updates = new Map<string, any>();

  /** Function to unsubscribe from changes to the doc, if we're listening. */
  private detachListener: Unsubscribe | undefined;

  /**
   * If a load() call is already in progress, this is a list of promise
   * resolutions to be called once the load is complete.  Otherwise undefined.
   */
  private resolvesWaitingForLoad:
    | { resolve: () => void; reject: (reason?: any) => void }[]
    | undefined;

  /**
   * @param schema the Zod object schema describing this document's data.
   * @param ref either a document reference specifying the full path of the
   *   document, or a collection reference specifying where a new document will
   *   be created.
   * @param options optional parameters for the resulting FiretenderDoc; see
   *   FiretenderDocOptions for detail.
   */
  constructor(
    schema: SchemaType,
    ref: DocumentReference | CollectionReference,
    options: AllFiretenderDocOptions = {}
  ) {
    this.schema = schema;
    this.ref = ref;
    this.isNewDoc = options.createDoc ?? false;
    this.isSettingNewContents = this.isNewDoc;
    if (options.initialData) {
      this.data = schema.parse(options.initialData);
    } else if (this.isNewDoc) {
      throw ReferenceError(
        "Initial data must be given when creating a new doc."
      );
    }
    if (this.ref instanceof DocumentReference) {
      this.docID = this.ref.path.split("/").pop();
    } else if (!this.isNewDoc) {
      throw TypeError(
        "FiretenderDoc can only take a collection reference when creating a new document.  Use .createNewDoc() if this is your intent."
      );
    }
  }

  /**
   * Returns a FiretenderDoc representing a new Firestore document.
   *
   * This method does not create the document in Firestore.  To do so, call the
   * write() method.
   *
   * @param schema the Zod object schema describing this document's data.
   * @param ref either a document reference specifying the full path of the
   *   document, or a collection reference specifying where a new document will
   *   be created.
   * @param initialData the document's initial data, which must define a valid
   *   instance of this document according to its schema.
   * @param options optional parameters for the resulting FiretenderDoc; see
   *   FiretenderDocOptions for detail.
   */
  static createNewDoc<SchemaType1 extends z.SomeZodObject>(
    schema: SchemaType1,
    ref: DocumentReference | CollectionReference,
    initialData: z.input<SchemaType1>,
    options: FiretenderDocOptions = {}
  ): FiretenderDoc<SchemaType1> {
    const mergedOptions: AllFiretenderDocOptions = {
      ...options,
      createDoc: true,
      initialData,
    };
    return new FiretenderDoc(schema, ref, mergedOptions);
  }

  /**
   * Creates a copy of this document.  Returns a deep copy of its data with a
   * specified or undefined Firestore ID and reference.
   *
   * This method does not create the document in Firestore.  To do so, call the
   * write() method.  If a document ID or reference is not provided, those will
   * be unset until the write.
   *
   * The location of the new document depends on the type of the `dest`
   * argument:
   * - `undefined` (default): It will be in the same collection and will be
   *   assigned a random ID when written to Firestore.
   * - `string`: It will be in the same collection and have a document ID given
   *   by `dest`.
   * - `string[]`: It will be in the specified subcollection and receive a
   *   random ID (if `type` does not give an ID for the deepest subcollection)
   *   or have the fully specified Firestore path (if `type` does).
   * - `DocumentReference`: It will have the given Firestore reference.
   * - `CollectionReference`: It will be in the given subcollection and have a
   *   randomly assigned ID upon writing.
   *
   * @param dest the location of the new document; see above for details.
   * @param options optional parameters for the resulting FiretenderDoc; see
   *   FiretenderDocOptions for detail.
   */
  copy(
    dest:
      | DocumentReference
      | CollectionReference
      | string
      | string[]
      | undefined = undefined,
    options: AllFiretenderDocOptions = {}
  ): FiretenderDoc<SchemaType> {
    if (!this.data) {
      throw new FiretenderUsageError(
        "You must call load() before making a copy."
      );
    }
    let ref: DocumentReference | CollectionReference;
    if (
      dest instanceof DocumentReference ||
      dest instanceof CollectionReference
    ) {
      ref = dest;
    } else if (Array.isArray(dest)) {
      const path = this.ref.path.split("/");
      if (path.length % 2 === 0) {
        // If this doc has a ID for the deepest collection, remove it so that
        // path always starts as a collection path.
        path.length -= 1;
      }
      const collectionDepth = (path.length + 1) / 2;
      if (dest.length < collectionDepth - 1 || dest.length > collectionDepth) {
        throw new FiretenderUsageError(
          "copy() with a path array requires an ID for all collections and subcollections, except optionally the last."
        );
      }
      dest.forEach((id, index) => {
        path[index * 2 + 1] = id;
      });
      ref =
        dest.length === collectionDepth
          ? doc(this.ref.firestore, path[0], ...path.slice(1))
          : collection(this.ref.firestore, path[0], ...path.slice(1));
    } else {
      // For a string or undefined ...
      const collectionRef =
        this.ref instanceof DocumentReference ? this.ref.parent : this.ref;
      if (dest) {
        ref = doc(collectionRef, dest);
      } else {
        ref = collectionRef;
      }
    }
    const mergedOptions: AllFiretenderDocOptions = {
      ...options,
      createDoc: true,
      initialData: this.data,
    };
    return new FiretenderDoc(this.schema, ref, mergedOptions);
  }

  /**
   * The document's ID string.
   *
   * @throws Throws an error if the document does not yet have an ID.
   */
  get id(): string {
    if (!this.docID) {
      throw new FiretenderUsageError(
        "id can only be accessed after the new doc has been written."
      );
    }
    return this.docID;
  }

  /**
   * The document's Firestore reference.
   *
   * @throws Throws an error if the document does not yet have a reference.
   */
  get docRef(): DocumentReference {
    if (!(this.ref instanceof DocumentReference)) {
      throw new FiretenderUsageError(
        "docRef can only be accessed after the new doc has been written."
      );
    }
    return this.ref;
  }

  /**
   * Is this a new doc that has not yet been written to Firestore?
   */
  isNew(): boolean {
    return this.isNewDoc;
  }

  /**
   * Does the document contain data, either because it was successfully loaded
   * or is newly created?
   */
  isLoaded(): boolean {
    return this.data !== undefined;
  }

  /**
   * Does this document contain data that has not yet been written to Firestore?
   */
  isPendingWrite(): boolean {
    return this.isSettingNewContents || this.updates.size > 0;
  }

  /**
   * Are we listening for changes to this document?
   */
  isListening(): boolean {
    return this.detachListener !== undefined;
  }

  /**
   * Loads this document's data from Firestore.
   *
   * @param options options for forcing the load or listening for changes.  See
   *   {@link LoadOptions} for details.
   */
  async load(
    options: LoadOptions<FiretenderDoc<SchemaType>> = {}
  ): Promise<this> {
    if (this.isNewDoc || this.ref instanceof CollectionReference) {
      throw new FiretenderUsageError(
        "load() should not be called for new documents."
      );
    }
    if (
      this.data &&
      !options.force &&
      (!options.listen || this.detachListener)
    ) {
      // We're already loaded, and we're listening if that was requested.
      return this;
    }
    if (this.resolvesWaitingForLoad !== undefined) {
      // Loading is already in progress.  Add this call to the waiting queue.
      await new Promise<void>((resolve, reject) => {
        this.resolvesWaitingForLoad!.push({ resolve, reject });
      });
      // We're done, unless listening was requested but not provided by the
      // previous call to load().
      if (!options.listen || this.detachListener) {
        return this;
      }
    }
    this.resolvesWaitingForLoad = [];
    let snapshot: DocumentSnapshot;
    if (options.listen) {
      const callback =
        typeof options.listen === "function" ? options.listen : undefined;
      const listener = (
        newSnapshot: DocumentSnapshot,
        initialResolve: (ns: DocumentSnapshot) => void
      ) => {
        if (!this.detachListener) {
          initialResolve(newSnapshot);
          return;
        }
        if (this.isPendingWrite()) {
          // Drop changes when a write is pending.  This listener will be called
          // again when the write happens, at which point it will include both
          // the locally written changes and the remote changes.
          return;
        }
        if (!snapshotExists(newSnapshot)) {
          // TODO: switch to "new doc" mode.
          return;
        }
        this.data = this.schema.parse(newSnapshot.data());
        // Dereference the old proxy to force a recapture of data.
        this.dataProxy = undefined;
        callback?.(this, newSnapshot);
      };
      let detach: Unsubscribe | undefined;
      snapshot = await new Promise((resolve) => {
        try {
          detach = onSnapshot(this.ref as DocumentReference, (newSnapshot) =>
            listener(newSnapshot, resolve)
          );
        } catch (error) {
          addContextToError(error, "onSnapshot", this.ref);
          throw error;
        }
      });
      this.detachListener = detach;
    } else {
      try {
        snapshot = await getDoc(this.ref);
      } catch (error) {
        addContextToError(error, "getDoc", this.ref);
        throw error;
      }
    }
    if (!snapshotExists(snapshot)) {
      const error = new FiretenderIOError(
        `Document does not exist: "${this.ref.path}"`
      );
      this.resolvesWaitingForLoad.forEach((wait) => wait.reject(error));
      throw error;
    }
    this.data = this.schema.parse(snapshot.data());
    // Dereference the old proxy, if any, to force a recapture of data.
    this.dataProxy = undefined;
    this.resolvesWaitingForLoad.forEach((wait) => wait.resolve());
    this.resolvesWaitingForLoad = undefined;
    return this;
  }

  /**
   * Read-only accessor to the contents of this document.
   */
  get r(): DeepReadonly<z.infer<SchemaType>> {
    if (!this.data) {
      throw new FiretenderUsageError(
        "load() must be called before reading the document."
      );
    }
    return this.data as DeepReadonly<z.infer<SchemaType>>;
  }

  /**
   * Writable accessor to update the contents of this document.
   *
   * Only use this accessor when making changes to the doc.  The .r accessor is
   * considerably more efficient when reading.
   */
  get w(): z.infer<SchemaType> {
    if (this.isSettingNewContents) {
      // No need to monitor changes if we're setting rather than updating.
      return this.data as z.infer<SchemaType>;
    }
    if (!this.dataProxy) {
      if (!this.data) {
        // TODO #23: Consider being able to update a doc without loading it.
        throw new FiretenderUsageError(
          "load() must be called before updating the document."
        );
      }
      this.dataProxy = watchForChanges(
        [],
        this.schema,
        this.data,
        this.addToUpdateList.bind(this)
      );
    }
    return this.dataProxy as z.infer<SchemaType>;
  }

  /**
   * Writable accessor to overwrite all the document data.
   */
  set w(newData: z.input<SchemaType>) {
    this.data = this.schema.parse(newData);
    this.isSettingNewContents = true;
    this.dataProxy = undefined;
  }

  /**
   * Writes the document or any updates to Firestore.
   */
  async write(): Promise<this> {
    // For new docs, this.data should contain its initial state.
    if (this.isSettingNewContents) {
      if (!this.data) {
        throw Error("New documents must be given data before calling write().");
      }
      if (this.ref instanceof DocumentReference) {
        try {
          await setDoc(this.ref, this.data);
        } catch (error) {
          addContextToError(error, "setDoc", this.ref, this.data);
          throw error;
        }
      } else {
        try {
          this.ref = await addDoc(this.ref, this.data);
        } catch (error: any) {
          addContextToError(error, "addDoc", this.ref, this.data);
          throw error;
        }
        this.docID = this.ref.path.split("/").pop(); // ID is last part of path.
      }
      this.isSettingNewContents = false;
      this.isNewDoc = false;
    }
    // For existing docs, this.updates should contain a list of changes.
    else {
      if (!(this.ref instanceof DocumentReference)) {
        // We should never get here.
        throw new FiretenderInternalError(
          "Internal error.  Firetender object should always reference a document when updating an existing doc."
        );
      }
      if (this.updates.size > 0) {
        const updateData = Object.fromEntries(this.updates);
        this.updates.clear();
        try {
          await updateDoc(this.ref, updateData);
        } catch (error: any) {
          addContextToError(error, "updateDoc", this.ref, updateData);
          throw error;
        }
      }
    }
    return this;
  }

  /**
   * Updates the document's data with a single call.
   *
   * This function loads the document's data, if necessary; calls the given
   * function to make changes to the data; then write the changes to Firestore.
   * If nothing else, it helps you avoid forgetting to call .write()!
   *
   * @param mutator function that accepts a writable data object and makes
   *   changes to it.
   */
  async update(mutator: (data: z.infer<SchemaType>) => void): Promise<this> {
    await this.load();
    mutator(this.w);
    await this.write();
    return this;
  }

  //////////////////////////////////////////////////////////////////////////////
  // Private functions

  /**
   * Adds a field and its new value to the list of updates to be passed to
   * Firestore's updateDoc().  Called when the proxies detect changes to the
   * document data.
   */
  private addToUpdateList<FieldSchemaType extends z.ZodTypeAny>(
    fieldPath: string[],
    newValue: z.infer<FieldSchemaType>
  ): void {
    let pathString = "";
    if (this.updates.size > 0) {
      // If there is already a list of mutations to send to Firestore, check if
      // a parent of this update is in it.  Objects in the update list are
      // references into this.data, so the parent field will automatically
      // reflect this change; no additional Firestore mutation is needed.
      if (
        fieldPath.some((field, i) => {
          pathString = pathString ? `${pathString}.${field}` : field;
          return i < fieldPath.length - 1 && this.updates.has(pathString);
        })
      ) {
        return;
      }
      // Remove any previous updates that this one overwrites.
      this.updates.forEach((value, key) => {
        if (key.startsWith(pathString)) {
          this.updates.delete(key);
        }
      });
    } else {
      // Shortcut for the common case of a single update being made.
      pathString = fieldPath.join(".");
    }
    this.updates.set(pathString, newValue);
  }
}
