/**
 * Typescript helper types.
 */

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

export type DeepReadonly<T> =
  T extends Array<infer ArrKey>
    ? ReadonlyArray<DeepReadonly<ArrKey>>
    : T extends Map<infer MapKey, infer MapVal>
      ? ReadonlyMap<DeepReadonly<MapKey>, DeepReadonly<MapVal>>
      : T extends Set<infer SetKey>
        ? ReadonlySet<DeepReadonly<SetKey>>
        : T extends Record<any, unknown>
          ? { readonly [ObjKey in keyof T]: DeepReadonly<T[ObjKey]> }
          : T;

/**
 * AsyncOrSync<Type> constructs a type with Type or Promise<Type>.
 *
 * Borrowed from:
 * https://github.com/ts-essentials/ts-essentials/blob/master/lib/async-or-sync
 */
export type AsyncOrSync<T> = T | Promise<T>;

export type AsyncOrSyncType<AsyncOrSyncType> =
  AsyncOrSyncType extends AsyncOrSync<infer Type> ? Type : never;
