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

export type FiretenderDocOptions = {
  createDoc?: true;
  initialData?: Record<string, any>;
  // TODO: #1 add readonly option.
};

export type PublicFiretenderDocOptions = Omit<
  FiretenderDocOptions,
  "createDoc" | "initialData"
>;

/**
 * Helper class for reading and writing Firestore data based on Zod schemas.
 */
export class FiretenderDoc<
  SchemaType extends z.SomeZodObject,
  DataType extends z.infer<SchemaType> = z.infer<SchemaType>
> {
  readonly schema: SchemaType;
  private ref: DocumentReference | CollectionReference;
  private isNewDoc: boolean;
  private docID: string | undefined = undefined;
  private data: DataType | undefined = undefined;
  private dataProxy: ProxyHandler<DataType> | undefined = undefined;
  private updates = new Map<string, any>();

  constructor(
    schema: SchemaType,
    ref: DocumentReference | CollectionReference,
    options: FiretenderDocOptions = {}
  ) {
    this.schema = schema;
    this.ref = ref;
    this.isNewDoc = options.createDoc ?? false;
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
        "Firetender can only take a collection reference when creating a new document.  Use Firetender.createNewDoc() if this is your intent."
      );
    }
  }

  static createNewDoc<
    SchemaType1 extends z.SomeZodObject,
    InputType extends z.input<SchemaType1> = z.input<SchemaType1>
  >(
    schema: SchemaType1,
    ref: DocumentReference | CollectionReference,
    initialData: InputType,
    options: PublicFiretenderDocOptions = {}
  ): FiretenderDoc<SchemaType1, z.infer<SchemaType1>> {
    const mergedOptions: FiretenderDocOptions = {
      ...options,
      createDoc: true,
      initialData,
    };
    return new FiretenderDoc(schema, ref, mergedOptions);
  }

  get id(): string {
    if (!this.docID) {
      throw Error(
        "id can only be accessed after the new doc has been written."
      );
    }
    return this.docID;
  }

  get docRef(): DocumentReference {
    if (this.ref.type !== "document") {
      throw Error(
        "docRef can only be accessed after the new doc has been written."
      );
    }
    return this.ref;
  }

  copy(
    dest:
      | DocumentReference
      | CollectionReference
      | string
      | undefined = undefined,
    options: FiretenderDocOptions = {}
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
    const mergedOptions: FiretenderDocOptions = {
      ...options,
      createDoc: true,
      initialData: this.data,
    };
    return new FiretenderDoc(this.schema, ref, mergedOptions);
  }

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

  get r(): DeepReadonly<DataType> {
    if (!this.data) {
      throw Error("load() must be called before reading the document.");
    }
    return this.data as DeepReadonly<DataType>;
  }

  get w(): DataType {
    if (this.isNewDoc) {
      // No need to monitor changes if we're creating rather than updating.
      return this.data as DataType;
    }
    if (!this.dataProxy) {
      if (!this.data) {
        throw Error("load() must be called before updating the document.");
      }
      this.dataProxy = watchFieldForChanges(
        [],
        this.schema,
        this.data,
        this.onChange.bind(this)
      );
    }
    return this.dataProxy as DataType;
  }

  async write(): Promise<this> {
    if (this.isNewDoc) {
      assertIsDefined(this.data);
      if (this.ref.type === "document") {
        await setDoc(this.ref, this.data);
      } else {
        this.ref = await addDoc(this.ref, this.data);
        this.docID = this.ref.path.split("/").pop();
      }
      this.isNewDoc = false;
    }
    // If existing doc:
    else {
      if (!(this.ref.type === "document")) {
        // We should never get here.
        throw Error(
          "Internal error.  Firetender object should always reference a document when updating an existing doc."
        );
      }
      if (this.updates.size > 0) {
        const flatUpdateList = Array.from(this.updates.entries()).flat();
        await updateDoc(
          this.ref,
          flatUpdateList[0],
          flatUpdateList[1],
          ...flatUpdateList.slice(2)
        );
      }
    }
    return this;
  }

  //////////////////////////////////////////////////////////////////////////////
  // Private functions

  private onChange<FieldSchemaType extends z.ZodTypeAny>(
    fieldPath: string[],
    newValue: z.infer<FieldSchemaType>
  ): void {
    let pathString = "";
    if (this.updates.size > 0) {
      // Check if some parent of this update is already in the list of mutations
      // to send to Firestore.  Objects in the update list are references into
      // this.data, so the parent field will automatically reflect this change;
      // no additional Firestore mutation is needed.
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
