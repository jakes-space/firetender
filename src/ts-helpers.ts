/**
 * Typescript-related helper functions and types.
 */

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

export type DeepReadonly<T> = T extends Array<infer ArrKey>
  ? ReadonlyArray<DeepReadonly<ArrKey>>
  : T extends Map<infer MapKey, infer MapVal>
  ? ReadonlyMap<DeepReadonly<MapKey>, DeepReadonly<MapVal>>
  : T extends Set<infer SetKey>
  ? ReadonlySet<DeepReadonly<SetKey>>
  : T extends Record<any, unknown>
  ? { readonly [ObjKey in keyof T]: DeepReadonly<T[ObjKey]> }
  : T;

export type MakeFieldsWithDefaultsOptional<T> = T extends Array<infer ArrKey>
  ? ReadonlyArray<DeepReadonly<ArrKey>>
  : T extends Map<infer MapKey, infer MapVal>
  ? ReadonlyMap<DeepReadonly<MapKey>, DeepReadonly<MapVal>>
  : T extends Set<infer SetKey>
  ? ReadonlySet<DeepReadonly<SetKey>>
  : T extends Record<any, unknown>
  ? { readonly [ObjKey in keyof T]: DeepReadonly<T[ObjKey]> }
  : T;

export function assertIsDefined<T>(value: T): asserts value is NonNullable<T> {
  if (value === undefined || value === null) {
    throw new TypeError(`${value} is not defined`);
  }
}

export function assertKeyIsString(key: any): asserts key is string {
  if (typeof key !== "string") {
    throw TypeError("Property access using symbols is not supported.");
  }
}
