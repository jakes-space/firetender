import { z } from "zod";

import { deleteField, isServerTimestamp, Timestamp } from "./firestore-deps";

/**
 * Getting this symbol from one of our proxies returns the proxy's target.
 */
const PROXY_TARGET_SYMBOL = Symbol("proxy_target");

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
 * If the wrapped field or one of its ancestors is an array, this won't work.
 * Firestore supports limited modification of arrays; see the 2018 blog entry at
 * https://firebase.blog/posts/2018/08/better-arrays-in-cloud-firestore for
 * details and some history.  The tl;dr is that we can't update array entries,
 * and arrayUnion() and arrayRemove() treat the array as a set.  So we have to
 * update the entire top-level array.  Child proxies maintain a link to the
 * top-level array ancestor and trigger a rewrite of the whole thing if there
 * are any changes to the contents.
 *
 * @param updatePath the Firestore path to be updated, as an array of strings.
 * @param fieldSchema schema of the object being wrapped.
 * @param field reference to the field in the local document data.
 * @param addToUpdateList callback to register updates to updatePath.
 * @param arrayAncestor a reference to the top-level array, if any.
 */
export function watchForChanges<
  FieldSchemaType extends z.ZodTypeAny,
  ArrayElementType,
>(
  updatePath: string[],
  fieldSchema: FieldSchemaType,
  field: z.infer<FieldSchemaType>,
  addToUpdateList: (path: string[], newValue: any) => void,
  arrayAncestor: ArrayElementType[] | undefined = undefined,
): z.infer<FieldSchemaType> {
  return new Proxy(field, {
    get(target, propertyKey): any {
      const property = target[propertyKey];
      if (property instanceof Function) {
        const result = (...args: any[]): any => property.apply(field, args);
        if (arrayAncestor) {
          // All methods of an array or its children are presumed to make
          // modifications, thus triggering an update of the full array.
          //
          // TODO: #11 Only mark updates for mutating array methods.
          //
          // Methods of all other objects are ignored.  This is safe because the
          // only other allowed objects are Records, which do not have mutating
          // methods.
          addToUpdateList(updatePath, arrayAncestor);
        }
        return result;
      }
      if (typeof propertyKey === "symbol") {
        // PROXY_TARGET_SYMBOL unwraps this proxy.
        if (propertyKey === PROXY_TARGET_SYMBOL) {
          return target;
        }
        // Allow all other symbols to pass through.
        return property;
      }
      if (property instanceof Object) {
        // Child objects need to be wrapped with another watchForChanges() call.
        let nextPath: string[];
        let nextArrayAncestor: any[] | undefined;
        if (arrayAncestor) {
          // Array ancestors should continue pointing to the top-level array.
          nextPath = updatePath;
          nextArrayAncestor = arrayAncestor;
        } else {
          // Otherwise the next proxy should point to this child.  If it's an
          // array, establish it as a top-level array.
          nextPath = [...updatePath, propertyKey];
          if (property instanceof Array) {
            nextArrayAncestor = property;
          }
        }
        return watchForChanges(
          nextPath,
          getPropertySchema(field, fieldSchema, propertyKey),
          property,
          addToUpdateList,
          nextArrayAncestor,
        );
      }
      // Otherwise we must be getting a primitive.  No need to wrap it.
      return property;
    },
    set(target, propertyKey, value): boolean {
      if (typeof propertyKey === "symbol") {
        // Allow symbols to pass through.
        return Reflect.set(target, propertyKey, value);
      }
      // If this is an array and its length is being set, truncate the array if
      // needed.
      if ((target as any) instanceof Array && propertyKey === "length") {
        if (typeof value !== "number") {
          throw TypeError(
            `Failed to set array length to ${value} (type: ${typeof value}).`,
          );
        }
        if (target.length > value) {
          target.length = value;
          addToUpdateList(updatePath, arrayAncestor);
        }
        return true;
      }
      let processedValue = value;
      // If the new value is an object wrapped in a Firetender proxy, which can
      // commonly happen when referencing it inside a mutator function passed to
      // FiretenderDoc.prototype.update(), unwrap it.
      if (value instanceof Object && value[PROXY_TARGET_SYMBOL]) {
        processedValue = value[PROXY_TARGET_SYMBOL];
      }
      // A property of this object is being set to a new value.  Parse the new
      // value with the appropriate schema, set it in the local data, and mark
      // the property (if we aren't inside an array) or the entire top-level
      // array (if we are) as needing to be written.  If the new value is
      // undefined, delete the property.
      const propertySchema = getPropertySchema(field, fieldSchema, propertyKey);
      processedValue = propertySchema.parse(processedValue);
      let result: boolean;
      if (processedValue === undefined) {
        processedValue = deleteField();
        result = Reflect.deleteProperty(target, propertyKey);
      } else {
        processedValue = pruneUndefinedFields(processedValue);
        result = Reflect.set(target, propertyKey, processedValue);
      }
      if (arrayAncestor) {
        addToUpdateList(updatePath, arrayAncestor);
      } else {
        addToUpdateList([...updatePath, propertyKey], processedValue);
      }
      return result;
    },
    deleteProperty(target, propertyKey): boolean {
      if (typeof propertyKey === "symbol") {
        // Allow symbols to pass through.
        return Reflect.deleteProperty(target, propertyKey);
      }
      let result = true;
      if ((target as any) instanceof Array) {
        // Calling Reflect.deleteProperty on an array item sets it to undefined,
        // which causes Firestore writes to fail if ignoreUndefinedProperties is
        // not set, and which is generally not what we want.  Hence splice.
        if (!propertyKey.match(/^\d+$/)) {
          throw TypeError(
            `Failed to delete an invalid array index: "${propertyKey}".`,
          );
        }
        const index = Number(propertyKey);
        target.splice(index, 1);
        // The delete operator pretty much always returns true, so do the same.
      } else {
        result = Reflect.deleteProperty(target, propertyKey);
      }
      if (arrayAncestor) {
        // Firestore's arrayRemove() deletes all matching entries, which is not
        // desired.  So we have to rewrite the full array.
        addToUpdateList(updatePath, arrayAncestor);
      } else {
        addToUpdateList([...updatePath, propertyKey], deleteField());
      }
      return result;
    },
  });
}

/**
 * Given a Zod schema representing a collection, returns the sub-schema of the
 * specified property.
 */
function getPropertySchema(
  parent: any,
  parentSchema: z.ZodTypeAny,
  propertyKey: string,
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
        if (
          schema.keySchema._def.typeName !== z.ZodFirstPartyTypeKind.ZodString
        ) {
          throw TypeError(
            `The ZodRecord for property ${propertyKey} has keys of type ${schema.keySchema._def.typeName}.  Only strings are supported.`,
          );
        }
        return schema.valueSchema;
      case z.ZodFirstPartyTypeKind.ZodArray:
        return schema.element;
      case z.ZodFirstPartyTypeKind.ZodObject:
        return schema.shape[propertyKey];
      case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
        schema = (schema as any).optionsMap.get(
          parent[(schema as any).discriminator],
        );
        continue;
      // If the parent is of type ZodAny, so are its properties.
      case z.ZodFirstPartyTypeKind.ZodAny:
        return z.any();
      default:
        throw TypeError(
          `Unsupported schema type for property "${propertyKey}": ${schema._def.typeName}`,
        );
    }
  }
}

/**
 * Returns a deep copy of the given object, omitting any undefined fields.
 *
 * Note: Timestamps and server timestamps pass through unmodified, but all other
 * objects will be stripped of their methods.
 */
function pruneUndefinedFields<T>(obj: T): T {
  if (
    typeof obj !== "object" ||
    obj === null ||
    obj instanceof Timestamp ||
    isServerTimestamp(obj)
  ) {
    return obj;
  }
  if (obj instanceof Array) {
    return obj
      .filter((v) => v !== undefined)
      .map((v) => pruneUndefinedFields(v)) as T;
  }
  return Object.fromEntries(
    Object.entries(obj as Record<string | number | symbol, unknown>)
      .filter(([_k, v]) => v !== undefined)
      .map(([k, v]) => [k, pruneUndefinedFields(v)]),
  ) as T;
}
