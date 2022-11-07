import { arrayRemove, deleteField } from "firebase/firestore";
import { z } from "zod";

import { assertKeyIsString } from "./ts-helpers";

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
