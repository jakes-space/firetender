import { Firestore } from "firebase/firestore";
import { z } from "zod";

import { FiretenderCollection } from "../FiretenderCollection";
import {
  cleanupFirestoreEmulator,
  setupFirestoreEmulator,
} from "./firestore-emulator";

const testSchema = z.object({
  foo: z.string(),
  bar: z.number().optional(),
});

const collectionName = "coltests";
let firestore: Firestore;
beforeAll(async () => {
  firestore = await setupFirestoreEmulator();
});

describe("createNewDoc", () => {
  it("creates a doc with the given ID.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName],
      { foo: "hello" }
    );
    const testDoc = testCollection.createNewDoc("111");
    expect(testDoc.id).toBe("111");
    expect(testDoc.r).toEqual({ foo: "hello" });
  });

  it("creates a doc without an ID.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName],
      { foo: "hello" }
    );
    const testDoc = testCollection.createNewDoc();
    expect(testDoc.id).toBeUndefined();
    expect(testDoc.r).toEqual({ foo: "hello" });
  });

  it("creates a doc in a subcollection.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName, "subcollection"],
      { foo: "hello" }
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const testDoc = testCollection.createNewDoc(["abc", "xyz"]);
    expect(testDoc.id).toBe("xyz");
    expect(testDoc.docRef.path).toBe(`${collectionName}/abc/subcollection/xyz`);
  });

  it("fails if an ID for a parent collection is missing.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName, "subcollection"],
      { foo: "hello" }
    );
    expect(() => testCollection.createNewDoc()).toThrowError("requires an ID");
  });

  it("merges given initial field values into the defaults.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName],
      { foo: "hello" }
    );
    const testDoc = testCollection.createNewDoc(undefined, { bar: 123 });
    expect(testDoc.id).toBeUndefined();
    expect(testDoc.r).toEqual({ foo: "hello", bar: 123 });
  });
});

describe("getExistingDoc", () => {
  it("wraps a doc in a collection.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName],
      { foo: "hello" }
    );
    const testDoc = testCollection.getExistingDoc("xyz");
    expect(testDoc.id).toBe("xyz");
  });

  it("wraps a doc in a subcollection.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName, "subcollection"],
      { foo: "hello" }
    );
    const testDoc = testCollection.getExistingDoc(["abc", "xyz"]);
    expect(testDoc.id).toBe("xyz");
    expect(testDoc.docRef.path).toBe(`${collectionName}/abc/subcollection/xyz`);
  });

  it("fails if an ID for a parent collection is missing.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName, "subcollection"],
      { foo: "hello" }
    );
    expect(() => testCollection.getExistingDoc("abc")).toThrowError(
      "requires an ID"
    );
  });
});

afterAll(async () => {
  await cleanupFirestoreEmulator();
});
