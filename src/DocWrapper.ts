import { CollectionReference, DocumentReference } from "firebase/firestore";
import { z } from "zod";
import { FireTenderDoc, FireTenderDocOptions } from "./FireTenderDoc";

/**
 * Factory for FireTenderDoc objects based on the given schema.
 */
export class DocWrapper<
  SchemaType extends z.SomeZodObject,
  DataType extends { [x: string]: any } = z.infer<SchemaType>
> {
  constructor(private schema: SchemaType) {}

  createNew(
    ref: DocumentReference | CollectionReference,
    initialData: any, // TODO: change to "DataType," after defaults are dropped.
    options: FireTenderDocOptions = {}
  ): FireTenderDoc<SchemaType, DataType> {
    const mergedOptions: FireTenderDocOptions = {
      ...options,
      createDoc: true,
      initialData,
    };
    return new FireTenderDoc(this.schema, ref, mergedOptions);
  }

  wrapExisting(
    ref: DocumentReference | CollectionReference,
    options: FireTenderDocOptions = {}
  ): FireTenderDoc<SchemaType, DataType> {
    return new FireTenderDoc(this.schema, ref, options);
  }
}
