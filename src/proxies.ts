import { arrayRemove, deleteField } from "firebase/firestore";
import { z } from "zod";

import { assertKeyIsString } from "./ts-helpers";

/**
 * Given a schema for a collection type, return the sub-schema of a specified
 * property.
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

export function watchArrayForChanges<
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
        // TODO: #11 Only mark the change for mutating function calls.
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

export function watchFieldForChanges<FieldSchemaType extends z.ZodTypeAny>(
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
