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
  initialData?: any;
  // TODO: add readonly option.
};

/**
 * Helper class for reading and writing Firestore data based on Zod schemas.
 */
export class FiretenderDoc<
  SchemaType extends z.SomeZodObject,
  DataType extends { [x: string]: any } = z.infer<SchemaType>
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
    if (this.isNewDoc) {
      if (!options.initialData) {
        throw ReferenceError(
          "Initial data must be given when creating a new doc."
        );
      }
      this.data = schema.parse(options.initialData);
    }
    if (this.ref.type === "document") {
      this.docID = this.ref.path.split("/").pop();
    } else if (!this.isNewDoc) {
      throw TypeError(
        "Firetender can only take a collection reference when creating a new document.  Use Firetender.createDoc() if this is your intent."
      );
    }
  }

  static createNewDoc<
    SchemaType1 extends z.SomeZodObject,
    InputType extends { [x: string]: any } = z.input<SchemaType1>
  >(
    schema: SchemaType1,
    ref: DocumentReference | CollectionReference,
    initialData: InputType,
    options: FiretenderDocOptions = {}
  ): FiretenderDoc<SchemaType1, z.TypeOf<SchemaType1>> {
    const mergedOptions: FiretenderDocOptions = {
      ...options,
      createDoc: true,
      initialData,
    };
    return new FiretenderDoc(schema, ref, mergedOptions);
  }

  static makeClassFactoryFor<
    SchemaType1 extends z.SomeZodObject,
    InputType extends { [x: string]: any } = z.input<SchemaType1>
  >(schema: SchemaType1) {
    return {
      createNewDoc: (
        ref: DocumentReference | CollectionReference,
        initialData: InputType,
        options: FiretenderDocOptions = {}
      ) => FiretenderDoc.createNewDoc(schema, ref, initialData, options),
      wrapExistingDoc: (
        ref: DocumentReference | CollectionReference,
        options: FiretenderDocOptions = {}
      ) => new FiretenderDoc(schema, ref, options),
    };
  }

  get id(): string | undefined {
    return this.docID;
  }

  get docRef(): DocumentReference {
    if (this.ref.type === "document") {
      return this.ref;
    }
    throw Error(
      "docRef can only be accessed after the new doc has been written."
    );
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
        throw Error("load() must be called before using the .w property.");
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

  async write(): Promise<void> {
    if (this.isNewDoc) {
      assertIsDefined(this.data);
      if (this.ref.type === "document") {
        await setDoc(this.ref, this.data);
      } else {
        this.ref = await addDoc(this.ref, this.data);
        this.docID = this.ref.path.split("/").pop();
      }
      this.isNewDoc = false;
    } else {
      if (!(this.ref.type === "document")) {
        // We should never get here.
        throw Error(
          "Internal error.  Firetender object should always reference a document when updating an existing doc."
        );
      }
      if (this.updates.size === 0) {
        return;
      }
      const flatUpdateList = Array.from(this.updates.entries()).flat();
      await updateDoc(
        this.ref,
        flatUpdateList[0],
        flatUpdateList[1],
        ...flatUpdateList.slice(2)
      );
    }
  }

  private onChange<FieldSchemaType extends z.ZodTypeAny>(
    fieldPath: string[],
    newValue: z.infer<FieldSchemaType>
  ) {
    this.updates.set(fieldPath.join("."), newValue);
  }
}