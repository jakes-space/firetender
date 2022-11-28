import { arrayRemove, deleteField } from "firebase/firestore";
import { z } from "zod";

import { assertKeyIsString } from "./ts-helpers";

/**
 * Given a Zod schema representing a collection, returns the sub-schema of the
 * specified property.
 */
function getPropertySchema(
  parentSchema: z.ZodTypeAny,
  propertyKey: string
): z.ZodTypeAny {
  let schema: any = parentSchema;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    switch (schema._def.typeName) {
      // If the schema object is wrapped (e.g., by being optional or having a
      // default), unwrap it until we get to the underlying collection type.
      case z.ZodFirstPartyTypeKind.ZodOptional:
      case z.ZodFirstPartyTypeKind.ZodNullable:
        schema = schema.unwrap();
        continue;
      case z.ZodFirstPartyTypeKind.ZodDefault:
        schema = schema.removeDefault();
        continue;
      case z.ZodFirstPartyTypeKind.ZodEffects:
        schema = schema.innerType();
        continue;
      // Return the sub-schemas of supported collection types.
      case z.ZodFirstPartyTypeKind.ZodRecord:
        return schema.valueSchema;
      case z.ZodFirstPartyTypeKind.ZodArray:
        return schema.element;
      case z.ZodFirstPartyTypeKind.ZodObject:
        return schema.shape[propertyKey];
      default:
        throw TypeError(
          `Unsupported schema type for property "${propertyKey}": ${schema._def.typeName}`
        );
    }
  }
}

/**
 * Wraps a top-level array, its elements, or its elements' subfields in a proxy
 * that watches for changes.
 *
 * Firestore supports limited modification of arrays; see the 2018 blog entry at
 * https://firebase.blog/posts/2018/08/better-arrays-in-cloud-firestore for
 * details and some history.  The tl;dr is that we can't update array entries;
 * we can only append or remove them.
 *
 * For this reason, this proxy only works with top-level arrays: the wrapped
 * array cannot be inside a parent array, though it may be in a record or nested
 * records.  Child proxies maintain a link to the top-level array and trigger a
 * rewrite of the whole thing if there are any changes to the contents.  As a
 * consequence, the watchFieldForChanges proxy (below) can produce child
 * watchArrayForChanges proxies, but all children of watchArrayForChanges will
 * always use the watchArrayForChanges proxy to maintain a reference to the
 * top-level array.
 *
 * Appending an element to the top-level array could in theory be supported, but
 * Firestore's arrayUnion operator only appends entries that don't already
 * exist.  That is not how Javascript arrays work, so to reduce logical overhead
 * we don't bother with it.
 *
 * Deletion of entries in the top-level array are handled using Firestore's
 * arrayRemove operator.  The deleted element gets removed entirely, so the
 * resulting array remains dense.  Note that this behavior differs from how
 * Javascript's delete operator normally works with arrays, but here we favor
 * Firestore's array semantics.
 *
 * @param arrayPath the dot-delimited path of the top-level array.
 * @param array a reference to the top-level array.
 * @param fieldSchema schema of the array element or a field nested within it.
 * @param field reference to the array element or one of its subfields.
 * @param addToUpdateList callback to register modifications to this array.
 */
export function watchArrayForChanges<
  ArrayElementType,
  FieldSchemaType extends z.ZodTypeAny
>(
  arrayPath: string[],
  array: ArrayElementType[],
  fieldSchema: FieldSchemaType,
  field: z.infer<FieldSchemaType>,
  addToUpdateList: (path: string[], newValue: any) => void
): z.infer<FieldSchemaType> {
  return new Proxy(field, {
    get(target, propertyKey) {
      const property = target[propertyKey];
      if (property instanceof Function) {
        // All methods of an array or its children are presumed to make
        // modifications, thus triggering an update of the full array.
        // TODO: #11 Only mark the change for mutating function calls.
        const result = (...args: any[]) => property.apply(field, args);
        addToUpdateList(arrayPath, array);
        return result;
      }
      if (typeof propertyKey === "symbol") {
        // Allow symbols to pass through.
        return property;
      }
      if (property instanceof Object) {
        // Wrap nested objects, including nested arrays, in child proxies.
        return watchArrayForChanges(
          arrayPath,
          array,
          getPropertySchema(fieldSchema, propertyKey),
          property,
          addToUpdateList
        );
      }
      // Otherwise we must be getting a primitive.  No need to wrap it.
      return property;
    },
    set(target, propertyKey, value) {
      if (typeof propertyKey === "symbol") {
        // Allow symbols to pass through.
        return Reflect.set(target, propertyKey, value);
      }
      // An array element or one of its subfields is being set to a new value.
      // Parse the new value with the appropriate schema, set it in the local
      // data, and mark the entire top-level array as needing to be written.
      const propertySchema = getPropertySchema(fieldSchema, propertyKey);
      const parsedValue = propertySchema.parse(value);
      const result = Reflect.set(target, propertyKey, parsedValue);
      addToUpdateList(arrayPath, array);
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
      // Only top-level elements can be deleted with Firestore's arrayRemove.
      if (target === array) {
        addToUpdateList(arrayPath, arrayRemove(removedValues[0]));
      } else {
        addToUpdateList(arrayPath, array);
      }
      return true;
    },
  });
}

/**
 * Wraps an object based on a Zod schema in a proxy that watches for changes.
 *
 * Nested fields are monitored by creating a chain of proxies.  Consider this
 * case:
 *
 *   testDoc.w.record1.record2.someStringValue = "foo";
 *
 * There is a top-level proxy (call it proxy 0) for the ".w" accessor.  Getting
 * ".record1" from it returns a child proxy (1) wrapping that field.  Getting
 * ".record2" from that returns another child proxy (2) wrapping that subfield.
 * Finally, setting ".someStringValue" uses the setter of proxy 2 to set the new
 * value locally and register an update to be sent to Firestore.
 *
 * The proxy returned by watchFieldForChanges is used for fields and subfields
 * when no parent is an array.  If a field or subfield is an array, the proxy
 * returned by watchArrayForChanges is used for it and all of its children,
 * regardless of whether they are arrays.
 *
 * @param fieldPath the dot-delimited path of the object being wrapped.
 * @param fieldSchema schema of the object's field.
 * @param field reference to the field in the local document data.
 * @param addToUpdateList callback to register modifications to this field.
 */
export function watchFieldForChanges<FieldSchemaType extends z.ZodTypeAny>(
  fieldPath: string[],
  fieldSchema: FieldSchemaType,
  field: z.infer<FieldSchemaType>,
  addToUpdateList: (path: string[], newValue: any) => void
): z.infer<FieldSchemaType> {
  return new Proxy(field, {
    get(target, propertyKey) {
      const property = target[propertyKey];
      if (property instanceof Function) {
        // Provide methods with a "this" reference for the underlying field.
        return (...args: any[]) => property.apply(field, args);
      }
      if (typeof propertyKey === "symbol") {
        // Allow symbols to pass through.
        return property;
      }
      if (property instanceof Array) {
        // Wrap array subfields in the watchArrayForChanges proxy.  It is
        // necessarily a top-level array, because otherwise we would be in
        // watchArrayForChanges already.
        return watchArrayForChanges(
          [...fieldPath, propertyKey],
          property,
          getPropertySchema(fieldSchema, propertyKey),
          property,
          addToUpdateList
        );
      }
      if (property instanceof Object) {
        // Wrap nested objects in another instance of this proxy.
        return watchFieldForChanges(
          [...fieldPath, propertyKey],
          getPropertySchema(fieldSchema, propertyKey),
          property,
          addToUpdateList
        );
      }
      // Otherwise we must be getting a primitive.  No need to wrap it.
      return property;
    },
    set(target, propertyKey, value) {
      if (typeof propertyKey === "symbol") {
        // Allow symbols to pass through.
        return Reflect.set(target, propertyKey, value);
      }
      // A property of this object is being set to a new value.  Parse the new
      // value with the appropriate schema, set it in the local data, and mark
      // the entire top-level array as needing to be written.
      const propertySchema = getPropertySchema(fieldSchema, propertyKey);
      const parsedValue = propertySchema.parse(value);
      addToUpdateList([...fieldPath, propertyKey], parsedValue);
      return Reflect.set(target, propertyKey, parsedValue);
    },
    deleteProperty(target, propertyKey) {
      assertKeyIsString(propertyKey);
      // Delete the field in Firestore by marking it with the deleteField
      // operator.
      addToUpdateList([...fieldPath, propertyKey], deleteField());
      return Reflect.deleteProperty(target, propertyKey);
    },
  });
}
