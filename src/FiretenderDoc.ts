import {
  addDoc,
  CollectionReference,
  doc,
  DocumentReference,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { z } from "zod";

import { watchFieldForChanges } from "./proxies";
import { assertIsDefined, DeepReadonly } from "./ts-helpers";

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
 * A local representation of a Firestore document.
 */
export class FiretenderDoc<
  SchemaType extends z.SomeZodObject,
  DataType extends z.infer<SchemaType> = z.infer<SchemaType>,
  InputType extends z.input<SchemaType> = z.input<SchemaType>
> {
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
  private data: DataType | undefined = undefined;

  /** Proxy to intercept write (.w) access to the data and track the changes */
  private dataProxy: ProxyHandler<DataType> | undefined = undefined;

  /** Map from the dot-delimited field path (per updateDoc()) to new value */
  private updates = new Map<string, any>();

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
    if (this.ref.type === "document") {
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
  static createNewDoc<
    SchemaType1 extends z.SomeZodObject,
    InputType1 extends z.input<SchemaType1> = z.input<SchemaType1>
  >(
    schema: SchemaType1,
    ref: DocumentReference | CollectionReference,
    initialData: InputType1,
    options: FiretenderDocOptions = {}
  ): FiretenderDoc<SchemaType1, z.infer<SchemaType1>> {
    const mergedOptions: AllFiretenderDocOptions = {
      ...options,
      createDoc: true,
      initialData,
    };
    return new FiretenderDoc(schema, ref, mergedOptions);
  }

  /**
   * Creates a copy of this document.  Returns a deep copy of its data with a
   * new Firestore ID and reference.
   *
   * This method does not create the document in Firestore.  To do so, call the
   * write() method.  If an ID or doc ref is not provided, those will be unset
   * until the write.
   *
   * @param dest the destination can be a string or undefined to create a copy
   *   in the same collection, or a document or collection reference to create
   *   it elsewhere.  Firestore will assign a random doc ID if dest is undefined
   *   or a collection reference.
   * @param options optional parameters for the resulting FiretenderDoc; see
   *   FiretenderDocOptions for detail.
   */
  copy(
    dest:
      | DocumentReference
      | CollectionReference
      | string
      | undefined = undefined,
    options: AllFiretenderDocOptions = {}
  ): FiretenderDoc<SchemaType, DataType> {
    if (!this.data) {
      throw Error("You must call load() before making a copy.");
    }
    let ref: DocumentReference | CollectionReference;
    if (dest && typeof dest !== "string") {
      ref = dest;
    } else {
      const collectionRef =
        this.ref.type === "document" ? this.ref.parent : this.ref;
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
      throw Error(
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
    if (this.ref.type !== "document") {
      throw Error(
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
   * Loads this document's data from Firestore.
   *
   * @param force force a read from Firestore.  Normally load() does nothing if
   *   the document already contains data.
   */
  async load(force = false): Promise<this> {
    if (this.isNewDoc || this.ref.type === "collection") {
      throw Error("load() should not be called for new documents.");
    }
    if (!this.data || force) {
      const snapshot = await getDoc(this.ref);
      if (!snapshot.exists()) {
        throw new Error("Document does not exist.");
      }
      this.data = this.schema.parse(snapshot.data());
      // Dereference the old proxy, if any, to force a recapture of data.
      this.dataProxy = undefined;
    }
    return this;
  }

  /**
   * Read-only accessor to the contents of this document.
   */
  get r(): DeepReadonly<DataType> {
    if (!this.data) {
      throw Error("load() must be called before reading the document.");
    }
    return this.data as DeepReadonly<DataType>;
  }

  /**
   * Writable accessor to update the contents of this document.
   *
   * Only use this accessor when making changes to the doc.  The .r accessor is
   * considerably more efficient when reading.
   */
  get w(): DataType {
    if (this.isSettingNewContents) {
      // No need to monitor changes if we're setting rather than updating.
      return this.data as DataType;
    }
    if (!this.dataProxy) {
      if (!this.data) {
        // TODO #23: Consider being able to update a doc without loading it.
        throw Error("load() must be called before updating the document.");
      }
      this.dataProxy = watchFieldForChanges(
        [],
        this.schema,
        this.data,
        this.addToUpdateList.bind(this)
      );
    }
    return this.dataProxy as DataType;
  }

  /**
   * Writable accessor to overwrite all the document data.
   */
  set w(newData: InputType) {
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
      assertIsDefined(this.data);
      if (this.ref.type === "document") {
        await setDoc(this.ref, this.data);
      } else {
        this.ref = await addDoc(this.ref, this.data);
        this.docID = this.ref.path.split("/").pop(); // ID is last part of path.
      }
      this.isSettingNewContents = false;
      this.isNewDoc = false;
    }
    // For existing docs, this.updates should contain a list of changes.
    else {
      if (!(this.ref.type === "document")) {
        // We should never get here.
        throw Error(
          "Internal error.  Firetender object should always reference a document when updating an existing doc."
        );
      }
      if (this.updates.size > 0) {
        // updateDoc() takes alternating field path and field value parameters.
        const flatUpdateList = Array.from(this.updates.entries()).flat();
        await updateDoc(
          this.ref,
          flatUpdateList[0],
          flatUpdateList[1],
          ...flatUpdateList.slice(2)
        );
        this.updates.clear();
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
  async update(mutator: (data: DataType) => void): Promise<this> {
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
