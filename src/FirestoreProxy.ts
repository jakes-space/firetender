import {
  addDoc,
  arrayRemove,
  CollectionReference,
  deleteField,
  doc,
  DocumentReference,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { type DocumentData } from "@firebase/firestore";
import { z } from "zod";

export type DeepReadonly<T> = T extends Array<infer ArrKey>
  ? ReadonlyArray<DeepReadonly<ArrKey>>
  : T extends Map<infer MapKey, infer MapVal>
  ? ReadonlyMap<DeepReadonly<MapKey>, DeepReadonly<MapVal>>
  : T extends Set<infer SetKey>
  ? ReadonlySet<DeepReadonly<SetKey>>
  : T extends Record<any, unknown>
  ? { readonly [ObjKey in keyof T]: DeepReadonly<T[ObjKey]> }
  : T;

function assertKeyIsString(key: any): asserts key is string {
  if (typeof key !== "string") {
    throw TypeError("Property access using symbols is not supported.");
  }
}

function assertIsDefined<T>(value: T): asserts value is NonNullable<T> {
  if (value === undefined || value === null) {
    throw new TypeError(`${value} is not defined`);
  }
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapSchema(schema.removeDefault());
  }
  if (schema instanceof z.ZodEffects) {
    return unwrapSchema(schema.innerType());
  }
  return schema;
}

function getPropertySchema(
  parentSchema: z.ZodTypeAny,
  propertyKey: string
): z.ZodTypeAny {
  const schema = unwrapSchema(parentSchema);
  if (schema instanceof z.ZodRecord) {
    return schema.valueSchema;
  }
  if (schema instanceof z.ZodArray) {
    return schema.element;
  }
  if (schema instanceof z.ZodObject) {
    return schema.shape[propertyKey];
  }
  throw TypeError(
    `Unsupported schema type for property "${propertyKey}": ${schema.constructor.name}`
  );
}

function watchArrayForChanges<
  ArrayElementType,
  FieldSchemaType extends z.ZodTypeAny
>(
  arrayPath: string[],
  array: ArrayElementType[],
  fieldSchema: FieldSchemaType,
  field: z.infer<FieldSchemaType>,
  onChange: (path: string[], newValue: any) => void
): z.infer<FieldSchemaType> {
  return new Proxy(field, {
    get(target, propertyKey) {
      assertKeyIsString(propertyKey);
      const property = target[propertyKey];
      if (property instanceof Function) {
        const result = (...args: any[]) => property.apply(field, args);
        // TODO (easy): have a list of functions that don't trigger onChange.
        // TODO (harder): also handle at, foreach, etc. methods to chain proxies
        // down from them.  But life's too short for that.
        onChange(arrayPath, array);
        return result;
      }
      if (property instanceof Object) {
        return watchArrayForChanges(
          arrayPath,
          array,
          getPropertySchema(fieldSchema, propertyKey),
          property,
          onChange
        );
      }
      return property;
    },
    set(target, propertyKey, value) {
      assertKeyIsString(propertyKey);
      const propertySchema = getPropertySchema(fieldSchema, propertyKey);
      const parsedValue = propertySchema.parse(value);
      const result = Reflect.set(target, propertyKey, parsedValue);
      onChange(arrayPath, array);
      return result;
    },
    deleteProperty(target, propertyKey) {
      assertKeyIsString(propertyKey);
      // Calling Reflect.deleteProperty on an array item sets it to undefined,
      // which causes Firestore updates to fail unless ignoreUndefinedProperties
      // is set, and which is generally not what we want.  Hence splice.
      const removedValues = array.splice(Number(propertyKey), 1);
      if (removedValues.length !== 1) {
        throw RangeError(
          `Failed to delete array item with index ${propertyKey}.  Out of bounds?`
        );
      }
      if (target === array) {
        onChange(arrayPath, arrayRemove(removedValues[0]));
      } else {
        onChange(arrayPath, array);
      }
      return true;
    },
  });
}

function watchFieldForChanges<FieldSchemaType extends z.ZodTypeAny>(
  fieldPath: string[],
  fieldSchema: FieldSchemaType,
  field: z.infer<FieldSchemaType>,
  onChange: (path: string[], newValue: any) => void
): z.infer<FieldSchemaType> {
  return new Proxy(field, {
    get(target, propertyKey) {
      assertKeyIsString(propertyKey);
      const property = target[propertyKey];
      if (property instanceof Function) {
        return (...args: any[]) => property.apply(field, args);
      }
      if (property instanceof Array) {
        return watchArrayForChanges(
          [...fieldPath, propertyKey],
          property,
          getPropertySchema(fieldSchema, propertyKey),
          property,
          onChange
        );
      }
      if (property instanceof Object) {
        return watchFieldForChanges(
          [...fieldPath, propertyKey],
          getPropertySchema(fieldSchema, propertyKey),
          property,
          onChange
        );
      }
      return property;
    },
    set(target, propertyKey, value) {
      assertKeyIsString(propertyKey);
      const propertySchema = getPropertySchema(fieldSchema, propertyKey);
      const parsedValue = propertySchema.parse(value);
      onChange([...fieldPath, propertyKey], parsedValue);
      return Reflect.set(target, propertyKey, parsedValue);
    },
    deleteProperty(target, propertyKey) {
      assertKeyIsString(propertyKey);
      onChange([...fieldPath, propertyKey], deleteField());
      return Reflect.deleteProperty(target, propertyKey);
    },
  });
}

type FirestoreProxyOptions = {
  createDoc?: true;
  initialData?: any;
  // TODO: add readonly option.
};

/**
 * Helper class for reading and writing Firestore data based on Zod schemas.
 */
export default class FirestoreProxy<
  SchemaType extends z.SomeZodObject,
  DataType extends { [x: string]: any } = z.infer<SchemaType>
> {
  readonly schema: SchemaType;
  private isNewDoc: boolean;
  private docID: string | undefined = undefined;
  private ref:
    | DocumentReference<DocumentData>
    | CollectionReference<DocumentData>;

  private data: DataType | undefined = undefined;
  private dataProxy: ProxyHandler<DataType> | undefined = undefined;
  private updates = new Map<string, any>();

  constructor(
    schema: SchemaType,
    ref: DocumentReference<DocumentData> | CollectionReference<DocumentData>,
    options: FirestoreProxyOptions = {}
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
    if (this.ref instanceof DocumentReference) {
      this.docID = this.ref.path.split("/").pop();
    } else if (!this.isNewDoc) {
      throw TypeError(
        "FirestoreProxy can only take a collection reference when creating a new document.  Use FirestoreProxy.createDoc() if this is your intent."
      );
    }
  }

  static createDoc<
    SchemaType1 extends z.SomeZodObject,
    DataType1 extends { [x: string]: any } = z.infer<SchemaType1>
  >(
    schema: SchemaType1,
    ref: DocumentReference<DocumentData> | CollectionReference<DocumentData>,
    initialData: DataType1,
    options: FirestoreProxyOptions = {}
  ): FirestoreProxy<SchemaType1, z.TypeOf<SchemaType1>> {
    const mergedOptions: FirestoreProxyOptions = {
      ...options,
      createDoc: true,
      initialData,
    };
    return new FirestoreProxy(schema, ref, mergedOptions);
  }

  get id(): string | undefined {
    return this.docID;
  }

  get docRef(): DocumentReference<DocumentData> {
    if (this.ref instanceof DocumentReference) {
      return this.ref;
    }
    throw Error(
      "docRef can only be accessed after the new doc has been written."
    );
  }

  copy(
    dest:
      | DocumentReference<DocumentData>
      | CollectionReference<DocumentData>
      | string
      | undefined = undefined,
    options: FirestoreProxyOptions = {}
  ): FirestoreProxy<SchemaType, DataType> {
    let ref:
      | DocumentReference<DocumentData>
      | CollectionReference<DocumentData>;
    if (
      dest instanceof DocumentReference ||
      dest instanceof CollectionReference
    ) {
      ref = dest;
    } else {
      const collectionRef =
        this.ref instanceof DocumentReference ? this.ref.parent : this.ref;
      if (dest) {
        ref = doc(collectionRef, dest);
      } else {
        ref = collectionRef;
      }
    }
    const mergedOptions: FirestoreProxyOptions = {
      ...options,
      createDoc: true,
      initialData: this.data,
    };
    return new FirestoreProxy(this.schema, ref, mergedOptions);
  }

  async load(force = false): Promise<void> {
    if (this.isNewDoc || !(this.ref instanceof DocumentReference)) {
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
  }

  get ro(): DeepReadonly<DataType> {
    if (!this.data) {
      throw Error("You must call load() before using the .ro pad.");
    }
    return this.data as DeepReadonly<DataType>;
  }

  get rw(): DataType {
    if (this.isNewDoc) {
      // No need to monitor changes if we're creating rather than updating.
      return this.data as DataType;
    }
    if (!this.dataProxy) {
      if (!this.data) {
        throw Error("You must call load() before using the .rw pad.");
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
      if (this.ref instanceof DocumentReference) {
        await setDoc(this.ref, this.data);
      } else {
        this.ref = await addDoc(this.ref, this.data);
        this.docID = this.ref.path.split("/").pop();
      }
      this.isNewDoc = false;
    } else {
      if (!(this.ref instanceof DocumentReference)) {
        // We should never get here.
        throw Error(
          "Internal error.  FirestoreProxy object should always reference a document when updating an existing doc."
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
