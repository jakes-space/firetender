import { z } from "zod";

import { deleteField, isServerTimestamp, Timestamp } from "./firestore-deps.js";

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
  FieldSchemaType extends z.ZodObject,
  ArrayElementType,
>(
  updatePath: (string | number)[],
  fieldSchema: FieldSchemaType,
  field: z.infer<FieldSchemaType>,
  addToUpdateList: (path: (string | number)[], newValue: any) => void,
  arrayAncestor: ArrayElementType[] | undefined = undefined,
): z.infer<FieldSchemaType> {
  return new Proxy<z.infer<FieldSchemaType>>(field, {
    get(target, propertyKey): any {
      const property = target[propertyKey as keyof typeof target];
      if (typeof propertyKey === "symbol") {
        // PROXY_TARGET_SYMBOL unwraps this proxy.
        if (propertyKey === PROXY_TARGET_SYMBOL) {
          return target;
        }
        // Allow all other symbols to pass through.
        return property;
      }
      if (!property) {
        // If the property is null or undefined, return it as is.
        return property;
      }
      if (typeof property === "function") {
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
        return property.bind(field);
      }
      if (typeof property === "object") {
        // Child objects need to be wrapped with another watchForChanges() call.
        let nextPath: (string | number)[];
        let nextArrayAncestor: any[] | undefined;
        if (arrayAncestor) {
          // Array ancestors should continue pointing to the top-level array.
          nextPath = updatePath;
          nextArrayAncestor = arrayAncestor;
        } else {
          // Otherwise the next proxy should point to this child.  If it's an
          // array, establish it as a top-level array.
          nextPath = [...updatePath, propertyKey];
          if (Array.isArray(property)) {
            nextArrayAncestor = property;
          }
        }
        const propertySchema = getPropertySchema(
          field,
          fieldSchema,
          propertyKey,
        ) as z.ZodObject;
        const propertyObject = property as Record<string, unknown>;
        return watchForChanges(
          nextPath,
          propertySchema,
          propertyObject,
          addToUpdateList,
          nextArrayAncestor,
        );
      }
      // Otherwise we must be getting a primitive.  No need to wrap it.
      return property;
    },
    set(target, propertyKey, value): boolean {
      if (typeof propertyKey === "symbol") {
        throw TypeError(
          `Failed to set property "${propertyKey.toString()}": symbols are not supported.`,
        );
      }
      // If this is an array and its length is being set, truncate the array if
      // needed.
      if (Array.isArray(target) && propertyKey === "length") {
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
      if (value && typeof value === "object") {
        const proxyTarget = value[PROXY_TARGET_SYMBOL];
        if (proxyTarget) {
          processedValue = proxyTarget;
        }
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
        throw TypeError(
          `Failed to delete property "${propertyKey.toString()}": symbols are not supported.`,
        );
      }
      let result = true;
      if (Array.isArray(target)) {
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
  parentSchema: z.ZodType,
  propertyKey: string | number,
): z.ZodTypeAny {
  let schema: any = parentSchema;
  while (true) {
    if (
      schema.type === "optional" ||
      schema.type === "nullable" ||
      schema.type === "default"
    ) {
      const unwrappableSchema = schema as
        | z.ZodOptional
        | z.ZodNullable
        | z.ZodDefault;
      schema = unwrappableSchema.unwrap();
    } else if (schema.type === "pipe") {
      const pipeSchema = schema as z.ZodPipe;
      schema = pipeSchema.in;
    } else if (schema.type === "record") {
      const recordSchema = schema as z.ZodRecord<z.ZodString, z.ZodTypeAny>;
      if (recordSchema.keyType.type !== "string") {
        throw TypeError(
          `The ZodRecord for property ${propertyKey} has keys of type ${recordSchema.keyType.type}.  Only strings are supported.`,
        );
      }
      return recordSchema.valueType;
    } else if (schema.type === "array") {
      const arraySchema = schema as z.ZodArray<z.ZodTypeAny>;
      return arraySchema.element;
    } else if (schema.type === "object") {
      const objectSchema = schema as z.ZodObject;
      return objectSchema.shape[propertyKey];
    } else if ("discriminator" in schema.def) {
      const discSchema = schema as z.ZodDiscriminatedUnion;
      const discValue: string = parent[discSchema.def.discriminator];
      const discKeys = [...discSchema._zod.propValues.type];
      const i = discKeys.findIndex((k) => k === discValue);
      if (i === -1) {
        throw TypeError(
          `Invalid discriminator value "${discValue}" for property "${propertyKey}".  Expected one of: ${discKeys.join(
            ", ",
          )}.`,
        );
      }
      schema = discSchema.options[i];
    } else if (schema.type === "any") {
      // If the parent is of type ZodAny, so are its properties.
      return z.any();
    } else {
      throw TypeError(
        `Unsupported schema type for property "${propertyKey}": ${schema.type}`,
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
  if (Array.isArray(obj)) {
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
