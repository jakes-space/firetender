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
import type {
  AsyncOrSync,
  AsyncOrSyncType,
  DeepReadonly,
} from "./ts-helpers.js";

/*
 * Functions that can patch the data from Firestore before it is parsed by Zod.
 */
export type BeforeParse = (
  data: Record<string, any>,
  docPath: string[],
) => AsyncOrSync<void | boolean | "write-soon" | "write-now">;

type HookReturnCode = AsyncOrSyncType<ReturnType<BeforeParse>>;

/*
 * Functions that can update the document after it has been read and parsed.
 */
export type AfterParse<SchemaType extends z.SomeZodObject> = (
  data: z.infer<SchemaType>,
  docPath: string[],
) => AsyncOrSync<void | false | "write-soon" | "write-now">;

/*
 * Functions that can update the document before it is written.
 */
export type BeforeWrite<SchemaType extends z.SomeZodObject> = (
  data: z.infer<SchemaType>,
  docPath: string[],
) => void;

/**
 * Internally used priority for writing changes made by the before/after parse
 * hooks.
 */
enum PatchPriority {
  NO_WRITE,
  WRITE_MANUALLY,
  WRITE_SOON,
  WRITE_NOW,
}

const convertPatcherReturnCodeToPriority = (
  code: HookReturnCode,
): PatchPriority => {
  switch (code) {
    case true:
      return PatchPriority.WRITE_MANUALLY;
    case "write-soon":
      return PatchPriority.WRITE_SOON;
    case "write-now":
      return PatchPriority.WRITE_NOW;
    default:
      return PatchPriority.NO_WRITE;
  }
};

/**
 * Public options for initializing a FiretenderDoc object.
 */
export type FiretenderDocOptions<SchemaType extends z.SomeZodObject> = {
  /**
   * If set, using the `.w` accessor or `.update()` method will throw an error
   * and changes made by hooks will not be written.
   */
  readonly?: boolean;

  /**
   * Functions to modify the data from Firestore before it is parsed by Zod.
   * They are called in order, waiting for any asynchronous functions to
   * complete before calling the next.
   *
   * The function's return type indicates if/when changes should be written:
   * - `false` or `undefined` - no changes that should be written were made.
   * - `true` - write the full document if/when the next write occurs.
   * - `"write-soon"` - write the full document after a delay of
   *   `writeSoonDelay` (default: 100 ms).
   * - `"write-now"` - write the full document immediately.  This write is
   *   synchronous; `load()` does not return until it has completed.
   *
   * The highest write priority is used.  Writing occurs after all `beforeParse`
   * and `afterParse` functions have been called.
   *
   * CAUTION: If any `beforeParse` function is truthy, the entire document will
   * be written.  If one function makes a change blocked by the Firestore rules
   * and returns `false`, but another returns `true`, all writes will fail.
   */
  beforeParse?: BeforeParse[];

  /**
   * Functions that can update the document after it has been read and parsed.
   * They are called in order, waiting for any asynchronous functions to
   * complete before calling the next.
   *
   * @returns A value indicating if/when any changes should be written:
   * - `false` or `undefined` - apply updates (if any) at the next write.
   * - `"write-soon"` - update the document after a delay of `writeSoonDelay`
   *   (default: 100 ms).
   * - `"write-now"` - update document immediately.  This write is synchronous;
   *   `load()` does not return until it has completed.
   *
   * The highest write priority is used.  Writing occurs after all the functions
   * have been called.
   */
  afterParse?: AfterParse<SchemaType>[];

  /**
   * Functions that can modify the document before it is written to Firestore.
   *
   * For example, this hook could set a last-modified timestamp at every write.
   */
  beforeWrite?: BeforeWrite<SchemaType>[];

  /**
   * Milliseconds before writing to Firestore for `"write-soon"`.  Defaults to
   * 100 ms.
   *
   * This delay can help avoid extra writes for quick read/modify/write cycles.
   */
  writeSoonDelay?: number;

  /**
   * Use the document's data as-is when it is loaded or provided; don't parse
   * and validate it.
   *
   * The `beforeParse` and `afterParse` hooks will still be called.
   *
   * WARNING: This option breaks type safety.  It is intended for debugging and
   * fixing incidents during schema migration.
   */
  disableValidation?: boolean;
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
     * The `beforeParse` and `afterParse` hooks are not called on this data.  To
     * initialize the document with data to be patched, use {@link loadRawData}
     * instead.
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

  /**
   * Catch errors that occur when changes happen.  Errors may be caused by
   * reading or parsing the document, in which case `listen` is not called, or
   * they may be uncaught errors from the `listen` callback.
   */
  onListenError?: (error: Error, doc: FiretenderDocType) => void;
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
  /** Zod schema used to parse and validate the document's data. */
  readonly schema: SchemaType;

  /** Firestore reference to this doc, or collection in which to create it. */
  private ref: DocumentReference | CollectionReference;

  /**
   * Firestore document ID, which is the last part of the document path.
   * Undefined for new docs not yet on Firestore.
   */
  private docID: string | undefined;

  /** If set, writes will throw and patches will not be written. */
  readonly isReadonly: boolean;

  /** If set, document data is copied rather than parsed and validated. */
  readonly isParsingDisabled: boolean;

  /** Is this a doc we presume does not yet exist in Firestore? */
  private isNewDoc: boolean;

  /** Use addDoc or setDoc to write all the data?  If not, use updateDoc. */
  private isSettingNewContents: boolean;

  /** Hooks to modify the raw data prior to parsing. */
  private readonly beforeParse: BeforeParse[];

  /** Hooks to update the document after reading and parsing. */
  private readonly afterParse: AfterParse<SchemaType>[];

  /** Hooks to update the document before writing it to Firestore. */
  private readonly beforeWrite: BeforeWrite<SchemaType>[];

  /** Delay before writing changes with `"write-soon"`.  Default is 100 ms. */
  private readonly writeSoonDelay: number;

  /** Local copy of the document data, parsed into the Zod type */
  private data: z.infer<SchemaType> | undefined;

  /** Proxy to intercept write (.w) access to the data and track the changes. */
  private dataProxy: ProxyHandler<z.infer<SchemaType>> | undefined;

  /** Map from the dot-delimited field path (per updateDoc()) to new value. */
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
    this.isParsingDisabled = options.disableValidation ?? false;
    this.isNewDoc = options.createDoc ?? false;
    if (this.isReadonly && this.isNewDoc) {
      throw new FiretenderUsageError(
        "Cannot create new docs in readonly mode.",
      );
    }
    this.isSettingNewContents = this.isNewDoc;
    this.beforeWrite = options.beforeWrite ?? [];
    this.beforeParse = options.beforeParse ?? [];
    this.afterParse = options.afterParse ?? [];
    this.writeSoonDelay = options.writeSoonDelay ?? 100;
    if (options.initialData) {
      this.data = this.parseOrClone(options.initialData);
    } else if (this.isNewDoc) {
      throw new FiretenderUsageError(
        "Initial data must be given when creating a new doc.",
      );
    }
    if (this.ref instanceof DocumentReference) {
      this.docID = this.ref.path.split("/").at(-1);
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
   * The document's ID string, which is the last part of the document path.
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
   * @param rawData the data to be loaded.  It may be modified in place by
   *   `beforeParse` hooks.
   */
  async loadRawData(rawData: Record<string, unknown>): Promise<this> {
    const patchRawPriority = await this.runBeforeParseHooks(rawData);
    this.data = this.parseOrClone(rawData);
    const patchParsedPriority = await this.runAfterParseHooks();
    await this.writePatches(Math.max(patchRawPriority, patchParsedPriority));
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
      const handleListenerError = (error: unknown): void =>
        options.onListenError?.(
          error instanceof Error ? error : new Error(`${error}`),
          this,
        );
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
          try {
            callback?.(this, newSnapshot);
          } catch (error) {
            handleListenerError(error);
          }
          return;
        }
        try {
          if (await this.loadFromSnapshot(newSnapshot, true)) {
            callback?.(this, newSnapshot);
          }
        } catch (error) {
          handleListenerError(error);
        }
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
    this.data = this.parseOrClone(newData);
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
      this.pruneUndefinedFields();
      this.runBeforeWriteHooks();
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
        this.docID = this.ref.path.split("/").at(-1);
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
        this.runBeforeWriteHooks();
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

  /** Parses or clones the given data, depending on `isParsingDisabled`. */
  private parseOrClone(data: Record<string, unknown>): z.infer<SchemaType> {
    return this.isParsingDisabled
      ? structuredClone(data)
      : this.schema.parse(data);
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
    const patchRawPriority = await this.runBeforeParseHooks(data);
    try {
      this.data = this.parseOrClone(data);
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
    const patchParsedPriority = await this.runAfterParseHooks();
    if (!isListener) {
      // Listeners do not write patches to avoid a feedback loop.
      await this.writePatches(Math.max(patchRawPriority, patchParsedPriority));
    }
    // Dereference the old proxy to force a recapture of data.
    this.dataProxy = undefined;
    return true;
  }

  /**
   * Applies patches to the given raw data.  Marks the entire document for
   * writing if any patcher returns a truthy value.
   *
   * @returns the priority for writing the revised document.
   */
  private async runBeforeParseHooks(
    data: Record<string, unknown>,
  ): Promise<PatchPriority> {
    let maxWritePriority: PatchPriority = PatchPriority.NO_WRITE;
    const docPath = this.ref.path.split("/");
    for (const hook of this.beforeParse) {
      const returnCode = await hook(data, docPath);
      const priority = convertPatcherReturnCodeToPriority(returnCode);
      maxWritePriority = Math.max(maxWritePriority, priority);
    }
    if (maxWritePriority > PatchPriority.NO_WRITE && !this.isReadonly) {
      this.isSettingNewContents = true;
    }
    return maxWritePriority;
  }

  /**
   * Applies patches to the document after reading and parsing.  The .w proxy is
   * used to track changes for writable documents, so it's safe for documents
   * with protected fields.
   *
   * @returns the priority for writing the updates.
   */
  private async runAfterParseHooks(): Promise<PatchPriority> {
    let maxWritePriority: PatchPriority = PatchPriority.NO_WRITE;
    const docPath = this.ref.path.split("/");
    for (const hook of this.afterParse) {
      const returnCode = await hook(
        this.isReadonly ? this.data! : this.w,
        docPath,
      );
      const priority = convertPatcherReturnCodeToPriority(returnCode);
      maxWritePriority = Math.max(maxWritePriority, priority);
    }
    return maxWritePriority;
  }

  /**
   * Depending on the priority, does nothing, schedules a write, or writes the
   * document immediately.
   */
  private async writePatches(priority: PatchPriority): Promise<void> {
    if (priority <= PatchPriority.WRITE_MANUALLY || this.isReadonly) {
      return;
    } else if (priority === PatchPriority.WRITE_SOON) {
      setTimeout(() => this.write(), this.writeSoonDelay);
    } else if (priority === PatchPriority.WRITE_NOW) {
      await this.write();
    }
  }

  /**
   * Applies the beforeWrite updates to the document.  The .w proxy is used to
   * track changes, making it safe for documents with protected fields.
   */
  private runBeforeWriteHooks(): void {
    const docPath = this.ref.path.split("/");
    for (const hook of this.beforeWrite) {
      hook(this.w, docPath);
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

  /**
   * Walk `this.data` and delete all fields with a value of `undefined`.
   */
  private pruneUndefinedFields(): void {
    if (!this.data) return;
    const recursivePrune = (data: Record<string, any>): void => {
      for (const key in data) {
        if (data[key] === undefined) {
          delete data[key];
        } else if (typeof data[key] === "object") {
          recursivePrune(data[key]);
        }
      }
    };
    recursivePrune(this.data);
  }
}
