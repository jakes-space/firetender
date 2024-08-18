import { z } from "zod";

import {
  addContextToError,
  FiretenderInternalError,
  FiretenderIOError,
  FiretenderUsageError,
  NullTimestampError,
} from "./errors.js";
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
} from "./firestore-deps.js";
import { watchForChanges } from "./proxy.js";
import { DeepReadonly } from "./ts-helpers.js";

/*
 * Patcher functions modify the data from Firestore before it is parsed by Zod.
 */
export type RawPatcher = (
  data: Record<string, any>,
) =>
  | void
  | boolean
  | "write-after-delay"
  | "write-soon"
  | "write-now"
  | Promise<void | boolean | "write-after-delay" | "write-soon" | "write-now">;

/**
 * Public options for initializing a FiretenderDoc object.
 */
export type FiretenderDocOptions<SchemaType extends z.SomeZodObject> = {
  /**
   * If set, using the `.w` accessor or `.update()` method will throw an error
   * and any data patches will not be written.
   */
  readonly?: boolean;

  /**
   * Hook to modify the document before it is written to Firestore.
   *
   * For example, this hook could set a last-modified timestamp at every write.
   */
  beforeWrite?: (data: z.infer<SchemaType>) => void;

  /**
   * Functions that modify the data from Firestore before it is parsed by Zod.
   * The patchers are applied to the data in the order given, each receiving the
   * output of the previous.  The output of the last is fed to Zod.
   *
   * @returns A value indicating if/when the patched data should be written:
   * - `false` or `undefined` - no changes that should be written were made.
   * - `true` - the full document should be written if/when the next write
   *   occurs.
   * - `"write-after-delay"` - write the full document after a delay, depending
   *   on the value of `writePatchAfterDelay`.  (Default: write after 500 ms.)
   * - `"write-soon"` - write the full document at the next opportunity.  This
   *   write is asynchronous; it does not delay the document's availability.
   * - `"write-now"` - write the full document immediately.  This write is
   *   synchronous; `load()` does not return until it has completed.
   *
   * The highest write priority is used.
   *
   * If a patcher returns `true` or `"write-*"`, the full document will be set
   * in Firestore.  Only return `true` if the Firestore rules allow updating all
   * defined fields.
   */
  rawPatchers?: RawPatcher[];

  /**
   * Whether and when to write the patched data back to Firestore:
   * - `false` - don't write the data back to Firestore.
   * - `true` - write the changes after 500 ms.  This is the default.
   * - a number - the delay in milliseconds; set it to 0 for no delay.
   *
   * This delay avoids an extra write in the case of a quick read/modify/write
   * cycle.  Defaults to `true`, for a half-second delay.
   */
  writePatchAfterDelay?: boolean | number;
};

/**
 * All options when initializing a FiretenderDoc object.
 *
 * This type includes options meant for internal use (createDoc, initialData)
 * as well as the options in FiretenderDocOptions.
 */
export type AllFiretenderDocOptions<SchemaType extends z.SomeZodObject> =
  FiretenderDocOptions<SchemaType> & {
    /**
     * Does this FiretenderDoc represent a new document in Firestore?
     */
    createDoc?: true;

    /**
     * The document's initial data, which must define a valid instance of the
     * document according to its schema.
     *
     * This data is not patched.  To iniitialize the document with data to be
     * patched, use {@link loadRawData} instead.
     */
    initialData?: DeepReadonly<Record<string, unknown>>;
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

type InternalLoadOptions<FiretenderDocType> = LoadOptions<FiretenderDocType> & {
  /**
   * Set if load() is being called recursively to retry a failed load due to a
   * recoverable condition (e.g., an empty or incomplete snapshot).
   *
   * If retryNumber reaches {@link NUM_LOAD_RETRIES} and the load still fails,
   * a FiretenderIOError is thrown.
   */
  retryNumber?: number;
};

const NUM_LOAD_RETRIES = 3;

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

  /** If set, writes will throw and patches will not be written. */
  readonly isReadonly: boolean;

  /** Is this a doc we presume does not yet exist in Firestore? */
  private isNewDoc: boolean;

  /** Use addDoc or setDoc to write all the data?  If not, use updateDoc. */
  private isSettingNewContents: boolean;

  /** Hook to modify the document before writing it to Firestore. */
  private readonly beforeWrite:
    | ((data: z.infer<SchemaType>) => void)
    | undefined;

  /** Raw patcher functions from options; applied to the raw data in order. */
  private readonly rawPatchers: RawPatcher[] | undefined;

  /** Don't write patches if false; delay in milliseconds if set. */
  private readonly writePatchAfterDelay: false | number;

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
    options: AllFiretenderDocOptions<SchemaType> = {},
  ) {
    this.schema = schema;
    this.ref = ref;
    this.isReadonly = options.readonly ?? false;
    this.isNewDoc = options.createDoc ?? false;
    if (this.isReadonly && this.isNewDoc) {
      throw new FiretenderUsageError(
        "Cannot create new docs in readonly mode.",
      );
    }
    this.isSettingNewContents = this.isNewDoc;
    this.beforeWrite = options.beforeWrite;
    this.rawPatchers = options.rawPatchers;
    this.writePatchAfterDelay =
      options.writePatchAfterDelay === true ||
      options.writePatchAfterDelay === undefined
        ? 500
        : options.writePatchAfterDelay === false
          ? false
          : options.writePatchAfterDelay;
    if (options.initialData) {
      this.data = schema.parse(options.initialData);
    } else if (this.isNewDoc) {
      throw new FiretenderUsageError(
        "Initial data must be given when creating a new doc.",
      );
    }
    if (this.ref instanceof DocumentReference) {
      this.docID = this.ref.path.split("/").pop();
    } else if (!this.isNewDoc) {
      throw TypeError(
        "FiretenderDoc can only take a collection reference when creating a new document.  Use .createNewDoc() if this is your intent.",
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
    options: FiretenderDocOptions<SchemaType1> = {},
  ): FiretenderDoc<SchemaType1> {
    const mergedOptions: AllFiretenderDocOptions<SchemaType1> = {
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
    options: AllFiretenderDocOptions<SchemaType> = {},
  ): FiretenderDoc<SchemaType> {
    if (!this.data) {
      throw new FiretenderUsageError(
        "You must call load() before making a copy.",
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
          "copy() with a path array requires an ID for all collections and subcollections, except optionally the last.",
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
    const mergedOptions: AllFiretenderDocOptions<SchemaType> = {
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
        "id can only be accessed after the new doc has been written.",
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
        "docRef can only be accessed after the new doc has been written.",
      );
    }
    return this.ref;
  }

  /**
   * Is this a new doc that has not yet been written to Firestore?
   */
  get isNew(): boolean {
    return this.isNewDoc;
  }

  /**
   * Does the document contain data, either because it was successfully loaded
   * or is newly created?
   */
  get isLoaded(): boolean {
    return this.data !== undefined;
  }

  /**
   * Does this document contain data that has not yet been written to Firestore?
   */
  get isPendingWrite(): boolean {
    return this.isSettingNewContents || this.updates.size > 0;
  }

  /**
   * Are we listening for changes to this document?
   */
  get isListening(): boolean {
    return this.detachListener !== undefined;
  }

  /**
   * Loads raw data, as read from Firestore, into the document.
   *
   * @param rawData the data to be loaded.  It will be patched in place if any
   *   patchers apply.
   */
  async loadRawData(rawData: Record<string, unknown>): Promise<this> {
    const isWriteNow = await this.patchData(rawData);
    this.data = this.schema.parse(rawData);
    if (isWriteNow) {
      await this.write();
    }
    return this;
  }

  /**
   * Loads this document's data from Firestore.
   *
   * @param options options for forcing the load or listening for changes.  See
   *   {@link LoadOptions} for details.
   */
  async load(
    options: InternalLoadOptions<FiretenderDoc<SchemaType>> = {},
  ): Promise<this> {
    if (this.isNewDoc || this.ref instanceof CollectionReference) {
      throw new FiretenderUsageError(
        "load() should not be called for new documents.",
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
    if (this.resolvesWaitingForLoad !== undefined && !options.retryNumber) {
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
    let snapshot: DocumentSnapshot | undefined;
    if (options.listen) {
      const callback =
        typeof options.listen === "function" ? options.listen : undefined;
      const listener = async (
        newSnapshot: DocumentSnapshot,
        initialResolve: (ns: DocumentSnapshot) => void,
      ): Promise<void> => {
        if (!this.detachListener) {
          initialResolve(newSnapshot);
          return;
        }
        if (this.isPendingWrite) {
          // Drop changes when a write is pending.  This listener will be called
          // again when the write happens, at which point it will include both
          // the locally written changes and the remote changes.
          return;
        }
        if (!snapshotExists(newSnapshot)) {
          // The doc was deleted on Firestore.  Mark this local representation
          // as a "new" document.
          this.isNewDoc = true;
          this.isSettingNewContents = true;
          this.dataProxy = undefined;
          callback?.(this, newSnapshot);
          return;
        }
        if (!(await this.loadFromSnapshot(newSnapshot, true))) {
          return;
        }
        callback?.(this, newSnapshot);
      };
      let detach: Unsubscribe | undefined;
      snapshot = await new Promise((resolve) => {
        try {
          detach = onSnapshot(this.ref as DocumentReference, (newSnapshot) =>
            listener(newSnapshot, resolve),
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
      } catch (error: any) {
        if (error.code !== "not-found" && error.code !== "permission-denied") {
          addContextToError(error, "getDoc", this.ref);
          throw error;
        }
        // Not found and permission errors are handled below; snapshot is left
        // undefined.
      }
    }
    if (!snapshot || !snapshotExists(snapshot)) {
      const error = new FiretenderIOError(
        `Document does not exist or insufficient permissions: "${this.ref.path}"`,
      );
      this.resolvesWaitingForLoad.forEach((wait) => wait.reject(error));
      throw error;
    }
    if (!(await this.loadFromSnapshot(snapshot, false))) {
      this.stopListening();
      const retryNumber = (options.retryNumber ?? 0) + 1;
      if (retryNumber <= NUM_LOAD_RETRIES) {
        // If the snapshot is missing or there was a null timestamp, wait a
        // moment then try again.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return this.load({ ...options, retryNumber });
      } else {
        const error = new FiretenderIOError(
          `Document is missing data: "${this.ref.path}"`,
        );
        this.resolvesWaitingForLoad.forEach((wait) => wait.reject(error));
        throw error;
      }
    }
    this.resolvesWaitingForLoad.forEach((wait) => wait.resolve());
    this.resolvesWaitingForLoad = undefined;
    return this;
  }

  /**
   * Stops listening to the remote doc for changes.
   */
  stopListening(): void {
    if (this.detachListener) {
      this.detachListener();
      this.detachListener = undefined;
    }
  }

  /**
   * Read-only accessor to the contents of this document.
   */
  get r(): DeepReadonly<z.infer<SchemaType>> {
    if (!this.data) {
      throw new FiretenderUsageError(
        "load() must be called before reading the document.",
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
    this.throwIfReadonly();
    if (this.isSettingNewContents) {
      // No need to monitor changes if we're setting rather than updating.
      return this.data!;
    }
    if (!this.dataProxy) {
      if (!this.data) {
        // TODO #23: Consider being able to update a doc without loading it.
        throw new FiretenderUsageError(
          "load() must be called before updating the document.",
        );
      }
      this.dataProxy = watchForChanges(
        [],
        this.schema,
        this.data,
        this.addToUpdateList.bind(this),
      );
    }
    return this.dataProxy as z.infer<SchemaType>;
  }

  /**
   * Writable accessor to overwrite all the document data.
   */
  set w(newData: z.input<SchemaType>) {
    this.throwIfReadonly();
    this.data = this.schema.parse(newData);
    this.isSettingNewContents = true;
    this.dataProxy = undefined;
  }

  /**
   * Writes the document or any updates to Firestore.
   */
  async write(): Promise<this> {
    this.throwIfReadonly();
    // For new docs, this.data should contain its initial state.
    if (this.isSettingNewContents) {
      if (!this.data) {
        // We should never get here: the constructor should have checked this.
        throw new FiretenderInternalError(
          "Internal error.  New documents should always have data before calling write().",
        );
      }
      this.beforeWrite?.(this.w);
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
          "Internal error.  Firetender object should always reference a document when updating an existing doc.",
        );
      }
      if (this.updates.size > 0) {
        this.beforeWrite?.(this.w);
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
    this.throwIfReadonly();
    if (!this.data) {
      await this.load();
    }
    mutator(this.w);
    await this.write();
    return this;
  }

  //////////////////////////////////////////////////////////////////////////////
  // Private functions

  private throwIfReadonly(): void {
    if (this.isReadonly) {
      throw new FiretenderUsageError(
        `An attempt was made to modify or write a read-only doc: ${this.docID}`,
      );
    }
  }

  /**
   * Given a snapshot, patch it, parse it, and save it as this doc's data.  If
   * not called from a listener, the patched data may be written to Firestore
   * after a delay.
   *
   * @returns true if the document's data was updated, false if the snapshot is
   *   missing data and was ignored.
   */
  private async loadFromSnapshot(
    snapshot: DocumentSnapshot,
    isListener = false,
  ): Promise<boolean> {
    const data = snapshot.data();
    if (!data) {
      // This seems to happen when the document is read while a write is in
      // progress.  Reject it without updating the doc.
      return false;
    }
    const isWriteNow = await this.patchData(data, isListener);
    let parsedData: z.infer<SchemaType>;
    try {
      parsedData = this.schema.parse(data);
    } catch (error) {
      if (error instanceof NullTimestampError) {
        // We are almost certainly in a listener, receiving the first snapshot
        // update of a timestamp being set to serverTimestamp().  Ignore it.
        // There will be another snapshot momentarily with the proper time.
        //
        // See https://stackoverflow.com/questions/64287252/ for background.
        return false;
      }
      throw error; // Rethrow otherwise.
    }
    this.data = parsedData;
    if (isWriteNow) {
      await this.write();
    }
    // Dereference the old proxy to force a recapture of data.
    this.dataProxy = undefined;
    return true;
  }

  /**
   * Applies the patches to the given data.  Writes the updates to Firestore if
   * `isListener` is not set and any patcher returns true.
   *
   * @returns `true` if the patched data should be written to Firestore
   * immediately and synchronously.
   */
  private async patchData(
    data: Record<string, unknown>,
    isListener = false,
  ): Promise<boolean> {
    if (!this.rawPatchers || this.rawPatchers.length === 0) {
      return false;
    }
    let maxWriteLevel: 0 | 1 | 2 | 3 | 4 = 0;
    for (const patcher of this.rawPatchers) {
      const writeLevel = await patcher(data);
      if (writeLevel === true && maxWriteLevel < 1) {
        maxWriteLevel = 1;
      } else if (writeLevel === "write-after-delay" && maxWriteLevel < 2) {
        maxWriteLevel = 2;
      } else if (writeLevel === "write-soon" && maxWriteLevel < 3) {
        maxWriteLevel = 3;
      } else if (writeLevel === "write-now") {
        maxWriteLevel = 4;
      }
    }
    if (maxWriteLevel === 0 || isListener || this.isReadonly) {
      // Listeners don't update the data on Firestore, as that would cause an
      // infinite loop of updates if a patcher always returns true.
      return false;
    }
    this.isSettingNewContents = true;
    if (maxWriteLevel === 1 /* true */) {
      return false;
    } else if (maxWriteLevel === 2 /* write-after-delay */) {
      if (this.writePatchAfterDelay !== false) {
        setTimeout(() => this.write(), this.writePatchAfterDelay);
      }
      return false;
    } else if (maxWriteLevel === 3 /* write-soon */) {
      setTimeout(() => this.write(), 0);
      return false;
    } else {
      return true; // write-now
    }
  }

  /**
   * Adds a field and its new value to the list of updates to be passed to
   * Firestore's updateDoc().  Called when the proxies detect changes to the
   * document data.
   */
  private addToUpdateList<FieldSchemaType extends z.ZodTypeAny>(
    fieldPath: string[],
    newValue: z.infer<FieldSchemaType>,
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
