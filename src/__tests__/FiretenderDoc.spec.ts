/**
 * Start before testing: pnpm run start-emulator
 *
 * TODO: #5 zod effects and preprocessing, but disallowing transforms
 */

import { z } from "zod";

import { FiretenderIOError } from "../errors.js";
import {
  addDoc,
  collection,
  CollectionReference,
  deleteDoc,
  doc,
  Firestore,
  FIRESTORE_DEPS_TYPE,
  getDoc,
  Timestamp,
  updateDoc,
} from "../firestore-deps.js";
import {
  AfterParse,
  BeforeParse,
  FiretenderDoc,
  FiretenderDocOptions,
} from "../FiretenderDoc.js";
import {
  futureTimestamp,
  serverTimestamp,
  serverTimestampWithClientTime,
  timestampSchema,
} from "../timestamps.js";
import {
  cleanupFirestoreEmulator,
  getFirestoreEmulator,
} from "./firestore-emulator.js";

const testDataSchema = z.object({
  email: z.string().email(),
  ttl: timestampSchema.optional(),
  recordOfPrimitives: z.record(z.string()).default({}),
  recordOfObjects: z
    .record(
      z.object({
        rating: z.number(),
        tags: z.array(z.string()).default([]),
        favoriteColor: z.string().optional(),
      }),
    )
    .default({}),
  nestedRecords: z.record(z.record(z.number())).default({}),
  arrayOfObjects: z
    .array(
      z.object({
        name: z.string(),
        entries: z.record(z.number()).default({}),
        favoriteColor: z.string().optional(),
      }),
    )
    .default([]),
  arrayOfDiscUnions: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("A"), someNumber: z.number() }),
        z.object({ type: z.literal("B"), someString: z.string() }),
        z.object({ type: z.literal("C"), someBoolean: z.boolean() }),
      ]),
    )
    .optional(),
  unreadable: z.boolean().optional(),
  constantField: z.number().optional(),
});
type TestDataInput = z.input<typeof testDataSchema>;

let firestore: Firestore;
let testCollection: CollectionReference;

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(86400e3); // If debugging, set the test timeout to 24 hours.
}

beforeAll(async () => {
  firestore = await getFirestoreEmulator();
  testCollection = collection(firestore, "doctests");
});

afterAll(cleanupFirestoreEmulator);

async function createAndLoadDoc(
  data: Record<string, unknown>,
  options: FiretenderDocOptions<typeof testDataSchema> = {},
): Promise<FiretenderDoc<typeof testDataSchema>> {
  const docRef = await addDoc(testCollection, data);
  return new FiretenderDoc(testDataSchema, docRef, options).load();
}

describe("constructor", () => {
  it("throws when creating a new doc without initial data", async () => {
    expect(() => {
      new FiretenderDoc(testDataSchema, testCollection, { createDoc: true });
    }).toThrow("Initial data must be given when creating a new doc.");
  });

  it("throws if given a collection ref without createDoc", async () => {
    expect(() => {
      new FiretenderDoc(testDataSchema, testCollection);
    }).toThrow(
      "can only take a collection reference when creating a new document.",
    );
  });
});

describe("load", () => {
  it("must be called before referencing the accessors", async () => {
    const testDoc = new FiretenderDoc(
      testDataSchema,
      doc(testCollection, "foo"),
    );
    expect(testDoc.isLoaded).toBe(false);
    expect(() => testDoc.r.email).toThrow(
      "load() must be called before reading the document.",
    );
    expect(() => testDoc.w.email).toThrow(
      "load() must be called before updating the document.",
    );
  });

  it("throws for a non-existent doc", async () => {
    const testDoc = new FiretenderDoc(
      testDataSchema,
      doc(testCollection, "foo"),
    );
    await expect(testDoc.load()).rejects.toThrow("does not exist");
  });

  it("throws for a doc blocked by Firestore rules", async () => {
    // Admin can read anywhere, so this test does not throw an error.
    if (FIRESTORE_DEPS_TYPE === "admin") return;
    const docRef = await addDoc(testCollection, {
      email: "bob@example.com",
      unreadable: true,
    });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    await expect(testDoc.load()).rejects.toThrow(FiretenderIOError);
  });

  it("throws for a created but not yet written doc", async () => {
    const testDoc = FiretenderDoc.createNewDoc(testDataSchema, testCollection, {
      email: "bob@example.com",
    });
    await expect(testDoc.load()).rejects.toThrow(
      "should not be called for new documents.",
    );
  });

  it("throws for an invalid doc", async () => {
    const docRef = await addDoc(testCollection, {}); // Missing email.
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    await expect(testDoc.load()).rejects.toThrow('"message": "Required"');
  });

  it("does not throw for an invalid doc with parsing disabled", async () => {
    const docRef = await addDoc(testCollection, {
      // Missing email.
      nonexistentField: "foo",
    });
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      disableValidation: true,
      beforeParse: [
        (data) => {
          data.ttl = "howdy";
        },
      ],
    });
    await testDoc.load();
    expect(testDoc.r).toEqual({
      nonexistentField: "foo",
      ttl: "howdy",
    });
  });

  it("always reads from Firestore if force is set", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    // testDoc does not show a change in Firestore until after a forced load.
    await updateDoc(testDoc.docRef, { email: "alice@example.com" });
    await testDoc.load(); // Does nothing.
    expect(testDoc.r.email).toBe("bob@example.com");
    await testDoc.load({ force: true });
    expect(testDoc.r.email).toBe("alice@example.com");
  });

  it("waits if a load call is already in progress", async () => {
    const docRef = await addDoc(testCollection, { email: "bob@example.com" });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    const loadingPromise1 = testDoc.load();
    expect(testDoc.isLoaded).toBeFalsy();
    const loadingPromise2 = testDoc.load();
    expect(testDoc.isLoaded).toBeFalsy();
    const loadingPromise3 = testDoc.load();
    expect(testDoc.isLoaded).toBeFalsy();
    await Promise.all([loadingPromise1, loadingPromise2, loadingPromise3]);
    expect(testDoc.isLoaded).toBeTruthy();
    expect(testDoc.r.email).toBe("bob@example.com");
  });

  it("retries on snapshot issues", async () => {
    const docRef = await addDoc(testCollection, {
      email: "bob@example.com",
      ttl: null, // Simulate a missing server timestamp.
    });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    await expect(testDoc.load()).rejects.toThrow("Document is missing data");
  });
});

describe("listener", () => {
  it("can listen for changes to a doc", async () => {
    const docRef = await addDoc(testCollection, { email: "bob@example.com" });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    let callbackCount = 0;
    await testDoc.load({
      listen: () => {
        callbackCount += 1;
      },
    });
    expect(testDoc.isListening).toBeTruthy();
    expect(callbackCount).toEqual(0);
    expect(testDoc.r.email).toBe("bob@example.com");
    await updateDoc(testDoc.docRef, { email: "alice@example.com" });
    expect(callbackCount).toEqual(1);
    expect(testDoc.r.email).toBe("alice@example.com");
    testDoc.stopListening();
    expect(testDoc.isListening).toBeFalsy();
    await updateDoc(testDoc.docRef, { email: "cindy@example.com" });
    expect(callbackCount).toEqual(1);
    expect(testDoc.r.email).toBe("alice@example.com");
  });

  it("can merge local and Firestore changse", async () => {
    const docRef = await addDoc(testCollection, { email: "bob@example.com" });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    let callbackCount = 0;
    await testDoc.load({
      listen: () => {
        callbackCount += 1;
      },
    });
    expect(callbackCount).toEqual(0);
    expect(testDoc.r.email).toBe("bob@example.com");
    testDoc.w.ttl = new Timestamp(123, 456000);
    await updateDoc(testDoc.docRef, { email: "alice@example.com" });
    expect(callbackCount).toEqual(0);
    await testDoc.write();
    expect(callbackCount).toEqual(1);
    expect(testDoc.r).toEqual({
      email: "alice@example.com",
      ttl: new Timestamp(123, 456000),
      recordOfPrimitives: {},
      recordOfObjects: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
      ttl: new Timestamp(123, 456000),
    });
  });

  it("marks the doc as new if the remote doc is deleted", async () => {
    const docRef = await addDoc(testCollection, { email: "bob@example.com" });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    let callbackCount = 0;
    await testDoc.load({
      listen: () => {
        callbackCount += 1;
      },
    });
    expect(callbackCount).toEqual(0);
    await deleteDoc(testDoc.docRef);
    expect(callbackCount).toEqual(1);
    expect(testDoc.isNew).toBeTruthy();
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      recordOfObjects: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("ignores server timestamp's initial update of null", async () => {
    const docRef = await addDoc(testCollection, { email: "bob@example.com" });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    let callbackCount = 0;
    await testDoc.load({
      listen: () => {
        callbackCount += 1;
      },
    });
    const nowMillis = Date.now();
    await testDoc.update((doc) => {
      doc.ttl = serverTimestamp();
    });
    // Wait a moment for the timestamp to be set by the server.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(callbackCount).toEqual(1);
    const doc = await getDoc(testDoc.docRef);
    const millisDiff = Math.abs(doc.data()?.ttl.toMillis() - nowMillis);
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
  });

  it("reports parsing errors to onListenError", async () => {
    const docRef = await addDoc(testCollection, { email: "alice@example.com" });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    const listen = jest.fn();
    let error: Error | undefined;
    const onListenError = jest.fn((e) => {
      error = e;
    });
    await testDoc.load({ listen, onListenError });
    expect(listen).toHaveBeenCalledTimes(0);
    expect(onListenError).toHaveBeenCalledTimes(0);
    expect(testDoc.r.email).toBe("alice@example.com");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await updateDoc(testDoc.docRef, { email: "invalid-email" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listen).toHaveBeenCalledTimes(0);
    expect(onListenError).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("Invalid email");
  });

  it("reports uncaught listener errors to onListenError", async () => {
    const docRef = await addDoc(testCollection, { email: "alice@example.com" });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    const listen = jest.fn(() => {
      throw Error("Uncaught error");
    });
    let error: Error | undefined;
    const onListenError = jest.fn((e) => {
      error = e;
    });
    await testDoc.load({ listen, onListenError });
    expect(listen).toHaveBeenCalledTimes(0);
    expect(onListenError).toHaveBeenCalledTimes(0);
    expect(testDoc.r.email).toBe("alice@example.com");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await updateDoc(testDoc.docRef, { email: "bob@example.com" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listen).toHaveBeenCalledTimes(1);
    expect(onListenError).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("Uncaught error");
  });
});

describe("read-only accessor (.r)", () => {
  it("reads a primitive field", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(testDoc.r.email).toBe("bob@example.com");
  });

  it("does not contain a missing optional field", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect("ttl" in testDoc.r).toBe(false);
  });
});

describe("writable accessor (.w)", () => {
  it("enforces schema rules when a field is set", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(() => {
      testDoc.w.email = "not a valid email";
    }).toThrow("Invalid email");
  });

  it("allows symbol properties to pass through objects", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 10,
        },
      },
    });
    // Converting an Object to a string gets its Symbol.toStringTag property.
    expect(String(testDoc.w.recordOfObjects)).toBe("[object Object]");
  });

  it("allows symbol properties to pass through arrays", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "foo", entries: {} },
        { name: "bar", entries: { a: 111, b: 222 } },
      ],
    });
    // Converting an Array to a string gets its Symbol.toStringTag property.
    expect(String(testDoc.w.arrayOfObjects)).toBe(
      "[object Object],[object Object]",
    );
  });

  it("can replace all document data", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 10,
        },
      },
    });
    testDoc.w = { email: "alice@example.com" };
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
      recordOfPrimitives: {},
      recordOfObjects: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("clears an optional field with delete operator", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      ttl: new Timestamp(123, 456000),
    });
    delete testDoc.w.ttl;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
    });
    // Note that Typescript itself prevents you from deleting required fields.
    // Attempting "delete testDoc.w.email;" is a TS compiler error.
  });

  it("clears an optional field set to undefined", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      ttl: new Timestamp(123, 456000),
    });
    testDoc.w.ttl = undefined;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
    });
  });

  it("deeply removes undefined fields", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      recordOfObjects: {
        c: { rating: 3, tags: ["111", "222"], favoriteColor: "red" },
        d: { rating: 4, tags: ["333", "444"] },
      },
      arrayOfObjects: [
        { name: "abc", entries: { x: 1, y: 2 } },
        { name: "xyz", favoriteColor: "blue" },
      ],
    });
    await testDoc.update((doc) => {
      doc.recordOfObjects.c = { rating: 5, tags: [], favoriteColor: undefined };
      doc.arrayOfObjects[1] = {
        name: "xyz",
        entries: {},
        favoriteColor: undefined,
      };
    });
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        c: { rating: 5, tags: [] },
        d: { rating: 4, tags: ["333", "444"] },
      },
      arrayOfObjects: [
        { name: "abc", entries: { x: 1, y: 2 } },
        { name: "xyz", entries: {} },
      ],
    });
  });

  it("throws in readonly mode", async () => {
    const testDoc = await createAndLoadDoc(
      {
        email: "bob@example.com",
      },
      { readonly: true },
    );
    expect(testDoc.isReadonly).toBeTruthy();
    expect(() => {
      testDoc.w.email = "alice@example.com";
    }).toThrow("An attempt was made to modify or write a read-only doc");
  });
});

describe("write", () => {
  it("sets a primitive field and updates Firestore", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    await testDoc.write(); // Should be a no-op since nothing has been changed.
    testDoc.w.email = "alice@example.com";
    expect(testDoc.r.email).toBe("alice@example.com");
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({ email: "alice@example.com" });
  });

  it("can update multiple fields", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    testDoc.w.email = "alice@example.com";
    testDoc.w.ttl = new Timestamp(123, 456000);
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
      ttl: new Timestamp(123, 456000),
    });
  });

  it("provides context on errors when adding a doc", async () => {
    // Admin can read anywhere, so this test does not throw an error.
    if (FIRESTORE_DEPS_TYPE === "admin") return;
    const badRef = collection(firestore, "not-in-access-rules");
    const badDoc = FiretenderDoc.createNewDoc(testDataSchema, badRef, {
      email: "bob@example.com",
    });
    await expect(badDoc.write()).rejects.toThrow();
    try {
      await badDoc.write();
    } catch (error: any) {
      expect(error.firetenderContext).toEqual({
        call: "addDoc",
        ref: "not-in-access-rules",
        data: {
          email: "bob@example.com",
          recordOfPrimitives: {},
          recordOfObjects: {},
          nestedRecords: {},
          arrayOfObjects: [],
        },
      });
    }
  });

  it("provides context on errors when updating a doc", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    await deleteDoc(testDoc.docRef);
    testDoc.w.email = "alice@example.com";
    await expect(testDoc.write()).rejects.toThrow();
    try {
      await testDoc.write();
    } catch (error: any) {
      expect(error.firetenderContext).toEqual({
        call: "updateDoc",
        ref: testDoc.docRef.path,
        data: { email: "alice@example.com" },
      });
    }
  });

  it("throws in readonly mode", async () => {
    const testDoc = await createAndLoadDoc(
      {
        email: "bob@example.com",
      },
      { readonly: true },
    );
    await expect(testDoc.write()).rejects.toThrow(
      "An attempt was made to modify or write a read-only doc",
    );
  });

  it("throws if adding a doc with a given ID fails", async () => {
    if (FIRESTORE_DEPS_TYPE === "admin") return; // Admin can write anywhere.
    const collectionRef = doc(firestore, "not-in-access-rules", "some-id");
    const testDoc = FiretenderDoc.createNewDoc(testDataSchema, collectionRef, {
      email: "bob@example.com",
    });
    await expect(testDoc.write()).rejects.toThrow("PERMISSION_DENIED");
  });

  it("throws if adding a doc without a given ID fails", async () => {
    if (FIRESTORE_DEPS_TYPE === "admin") return; // Admin can write anywhere.
    const collectionRef = collection(firestore, "not-in-access-rules");
    const testDoc = FiretenderDoc.createNewDoc(testDataSchema, collectionRef, {
      email: "bob@example.com",
    });
    await expect(testDoc.write()).rejects.toThrow("PERMISSION_DENIED");
  });
});

describe("update", () => {
  it("loads, updates, and writes a document", async () => {
    const docRef = await addDoc(testCollection, { email: "bob@example.com" });
    await new FiretenderDoc(testDataSchema, docRef).update((data) => {
      data.email = "alice@example.com";
      data.arrayOfObjects.push({ name: "foo", entries: {} });
    });
    const result = (await getDoc(docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
      arrayOfObjects: [
        {
          name: "foo",
          entries: {},
        },
      ],
    });
  });

  it("throws in readonly mode", async () => {
    const testDoc = await createAndLoadDoc(
      {
        email: "bob@example.com",
      },
      { readonly: true },
    );
    expect(testDoc.isReadonly).toBeTruthy();
    await expect(
      testDoc.update((data) => {
        data.email = "alice@example.com";
      }),
    ).rejects.toThrow("An attempt was made to modify or write a read-only doc");
  });

  it("updates a new doc", async () => {
    const testDoc = new FiretenderDoc(testDataSchema, testCollection, {
      createDoc: true,
      initialData: {
        email: "bob@example.com",
      },
    });
    expect(testDoc.isNew).toBeTruthy();
    await testDoc.update((data) => {
      data.email = "alice@example.com";
    });
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: {},
      arrayOfObjects: [],
    });
  });
});

describe("beforeParse", () => {
  it("writes changes with other data if true is returned", async () => {
    const docRef = await addDoc(testCollection, { email: "alice" });
    const patcher: BeforeParse = (data, path) => {
      expect(path).toEqual(["doctests", docRef.id]);
      data.email += "@example.com";
      return true;
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      beforeParse: [patcher],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("alice@example.com");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resultBeforeUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultBeforeUpdate).toEqual({
      email: "alice",
    });
    await testDoc.update((data) => {
      data.recordOfPrimitives.foo = "bar";
    });
    const resultAfterUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultAfterUpdate).toEqual({
      email: "alice@example.com",
      recordOfPrimitives: { foo: "bar" },
      recordOfObjects: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("does not write changes if false is returned", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice",
      constantField: 1,
    });
    const patcher: BeforeParse = (data: any) => {
      data.email += "@example.com";
      data.constantField = 2;
      return false;
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      beforeParse: [patcher],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("alice@example.com");
    expect(testDoc.r.constantField).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resultBeforeUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultBeforeUpdate).toEqual({
      email: "alice",
      constantField: 1,
    });
    await testDoc.update((data) => {
      data.recordOfPrimitives.foo = "bar";
    });
    const resultAfterUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultAfterUpdate).toEqual({
      email: "alice",
      constantField: 1,
      recordOfPrimitives: { foo: "bar" },
    });
  });

  it("throws if an unwriteable field is modified (web only)", async () => {
    if (FIRESTORE_DEPS_TYPE === "admin") {
      return; // Admin can write anywhere.
    }
    const docRef = await addDoc(testCollection, {
      email: "alice",
      constantField: 1,
    });
    const patcher: BeforeParse = (data: any) => {
      data.email += "@example.com";
      data.constantField = 2;
      return true;
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      beforeParse: [patcher],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("alice@example.com");
    expect(testDoc.r.constantField).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resultBeforeUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultBeforeUpdate).toEqual({
      email: "alice",
      constantField: 1,
    });
    await expect(
      testDoc.update((data) => {
        data.recordOfPrimitives.foo = "bar";
      }),
    ).rejects.toThrow("PERMISSION_DENIED");
  });

  it("writes after a delay", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice",
    });
    const patcher: BeforeParse = (data: any) => {
      data.email += "@example.com";
      return "write-soon";
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      beforeParse: [patcher],
      writeSoonDelay: 25,
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("alice@example.com");
    const resultBeforeDelay = (await getDoc(testDoc.docRef)).data();
    expect(resultBeforeDelay).toEqual({
      email: "alice",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resultAfterDelay = (await getDoc(testDoc.docRef)).data();
    expect(resultAfterDelay).toEqual({
      email: "alice@example.com",
      recordOfPrimitives: {},
      recordOfObjects: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("writes immediately", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice",
    });
    const patcher: BeforeParse = (data: any) => {
      data.email += "@example.com";
      return "write-now";
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      beforeParse: [patcher],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("alice@example.com");
    expect(testDoc.isPendingWrite).toBeFalsy();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
      recordOfPrimitives: {},
      recordOfObjects: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("applies asynchronous patches", async () => {
    const docRef = await addDoc(testCollection, {});
    const patcher1: BeforeParse = async (data: any): Promise<"write-now"> => {
      data.email = "alice";
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "write-now";
    };
    const patcher2: BeforeParse = (data: any) => {
      data.email += "@example.com";
      return "write-now";
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      beforeParse: [patcher1, patcher2],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("alice@example.com");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
      recordOfPrimitives: {},
      recordOfObjects: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("works with read-only docs", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice",
    });
    const patcher: BeforeParse = (data: any) => {
      data.email += "@example.com";
      return "write-now";
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      beforeParse: [patcher],
      readonly: true,
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("alice@example.com");
    expect(testDoc.isPendingWrite).toBeFalsy();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice",
    });
  });
});

describe("afterParse", () => {
  it("writes changes with other data if true is returned", async () => {
    const docRef = await addDoc(testCollection, { email: "alice@example.com" });
    const patcher: AfterParse<typeof testDataSchema> = (data, path) => {
      expect(path).toEqual(["doctests", docRef.id]);
      data.email = data.email.replace("alice", "bob");
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      afterParse: [patcher],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("bob@example.com");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resultBeforeUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultBeforeUpdate).toEqual({
      email: "alice@example.com",
    });
    await testDoc.update((data) => {
      data.recordOfPrimitives.foo = "bar";
    });
    const resultAfterUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultAfterUpdate).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: { foo: "bar" },
    });
  });

  it("is OK if an unwriteable field is defined", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice@example.com",
      constantField: 1,
    });
    const patcher: AfterParse<typeof testDataSchema> = (data: any) => {
      data.email = data.email.replace("alice", "bob");
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      afterParse: [patcher],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("bob@example.com");
    expect(testDoc.r.constantField).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resultBeforeUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultBeforeUpdate).toEqual({
      email: "alice@example.com",
      constantField: 1,
    });
    await testDoc.update((data) => {
      data.recordOfPrimitives.foo = "bar";
    });
    const resultAfterUpdate = (await getDoc(testDoc.docRef)).data();
    expect(resultAfterUpdate).toEqual({
      email: "bob@example.com",
      constantField: 1,
      recordOfPrimitives: { foo: "bar" },
    });
  });

  it("writes after a delay", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice@example.com",
    });
    const patcher: AfterParse<typeof testDataSchema> = (data: any) => {
      data.email = data.email.replace("alice", "bob");
      return "write-soon";
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      afterParse: [patcher],
      writeSoonDelay: 25,
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("bob@example.com");
    const resultBeforeDelay = (await getDoc(testDoc.docRef)).data();
    expect(resultBeforeDelay).toEqual({
      email: "alice@example.com",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resultAfterDelay = (await getDoc(testDoc.docRef)).data();
    expect(resultAfterDelay).toEqual({
      email: "bob@example.com",
    });
  });

  it("writes synchronously", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice@example.com",
    });
    const patcher: AfterParse<typeof testDataSchema> = (data: any) => {
      data.email = data.email.replace("alice", "bob");
      return "write-now";
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      afterParse: [patcher],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("bob@example.com");
    expect(testDoc.isPendingWrite).toBeFalsy();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
    });
  });

  it("applies asynchronous patches", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice@example.com",
    });
    const patcher1: AfterParse<typeof testDataSchema> = async (data) => {
      data.email = data.email.replace("alice", "bob");
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "write-now" as const;
    };
    const patcher2: AfterParse<typeof testDataSchema> = (data) => {
      data.email = data.email.replace("bob", "robert");
      return "write-now";
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      afterParse: [patcher1, patcher2],
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("robert@example.com");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "robert@example.com",
    });
  });

  it("works with read-only docs", async () => {
    const docRef = await addDoc(testCollection, {
      email: "alice@example.com",
    });
    const patcher: AfterParse<typeof testDataSchema> = (data: any) => {
      data.email = data.email.replace("alice", "bob");
      return "write-now";
    };
    const testDoc = new FiretenderDoc(testDataSchema, docRef, {
      afterParse: [patcher],
      readonly: true,
    });
    await testDoc.load();
    expect(testDoc.r.email).toBe("bob@example.com");
    expect(testDoc.isPendingWrite).toBeFalsy();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
    });
  });
});

describe("beforeWrite", () => {
  it("modifies a new doc", async () => {
    const testDoc = new FiretenderDoc(testDataSchema, testCollection, {
      createDoc: true,
      initialData: {
        email: "bob@example.com",
      },
      beforeWrite: [
        (data, path) => {
          expect(path).toEqual(["doctests"]);
          data.ttl = serverTimestamp();
        },
      ],
    });
    expect(testDoc.isNew).toBeTruthy();
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toBeDefined();
    expect(result?.email).toBe("bob@example.com");
    const millisDiff = Math.abs(result?.ttl.toMillis() - Date.now());
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
  });

  it("modifies an existing doc", async () => {
    const docRef = await addDoc(testCollection, {
      email: "bob@example.com",
    });
    const testDoc = await new FiretenderDoc(testDataSchema, docRef, {
      beforeWrite: [
        (data, path) => {
          expect(path).toEqual(["doctests", docRef.id]);
          data.ttl = serverTimestamp();
        },
      ],
    }).load();
    expect(testDoc.r.ttl).toBeUndefined();
    await testDoc.update((data) => {
      data.email = "alice@example.com";
    });
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toBeDefined();
    expect(result?.email).toBe("alice@example.com");
    const millisDiff = Math.abs(result?.ttl.toMillis() - Date.now());
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
  });
});

describe("record of primitives", () => {
  const initialState: TestDataInput = {
    email: "bob@example.com",
    recordOfPrimitives: {
      foo: "xyz",
    },
  };

  it("reads an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect(testDoc.r.recordOfPrimitives.foo).toBe("xyz");
  });

  it("modifies an existing entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.recordOfPrimitives.foo = "abc";
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {
        foo: "abc",
      },
    });
  });

  it("adds an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.recordOfPrimitives.bar = "abc";
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {
        foo: "xyz",
        bar: "abc",
      },
    });
  });

  it("deletes an entry", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      recordOfPrimitives: { foo: "xyz" },
    });
    delete testDoc.w.recordOfPrimitives.foo;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
    });
  });

  it("can set all record contents", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      recordOfPrimitives: { foo: "xyz" },
    });
    testDoc.w.recordOfPrimitives = { bar: "abc" };
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {
        bar: "abc",
      },
    });
  });
});

describe("record of objects", () => {
  const initialState: TestDataInput = {
    email: "bob@example.com",
    recordOfObjects: {
      "ice cream": {
        rating: 10,
      },
      spinach: {
        rating: 5,
        tags: ["green", "healthy"],
      },
    },
  };

  it("reads an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect("ice cream" in testDoc.r.recordOfObjects).toBe(true);
    expect(testDoc.r.recordOfObjects["ice cream"].rating).toBe(10);
    expect(testDoc.r.recordOfObjects["ice cream"].tags.length).toBe(0);
    expect(testDoc.r.recordOfObjects.spinach.tags.includes("green")).toBe(true);
  });

  it("modifies an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.recordOfObjects["ice cream"] = {
      rating: 8,
      tags: ["too much lactose"],
    };
    testDoc.w.recordOfObjects.spinach.rating = 6;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 8,
          tags: ["too much lactose"],
        },
        spinach: {
          rating: 6,
          tags: ["green", "healthy"],
        },
      },
    });
  });

  it("correctly updates a parent field followed by a child", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.recordOfObjects["ice cream"] = { rating: 4, tags: ["abc"] };
    testDoc.w.recordOfObjects["ice cream"].rating = 5;
    testDoc.w.recordOfObjects["ice cream"].tags.push("xyz");
    // .updates is private, so we coerce testDoc into "any".
    const updates: Map<string, any> = (testDoc as any).updates;
    expect(updates.size).toBe(1);
    expect(updates.keys().next().value).toBe("recordOfObjects.ice cream");
    expect(updates.values().next().value).toEqual({
      rating: 5,
      tags: ["abc", "xyz"],
    });
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 5,
          tags: ["abc", "xyz"],
        },
        spinach: {
          rating: 5,
          tags: ["green", "healthy"],
        },
      },
    });
  });

  it("correctly updates a child field followed by a parent", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.recordOfObjects["ice cream"].rating = 5;
    testDoc.w.recordOfObjects["ice cream"].tags.push("xyz");
    testDoc.w.recordOfObjects["ice cream"] = { rating: 4, tags: ["abc"] };
    // .updates is private, so we coerce testDoc into "any".
    const updates: Map<string, any> = (testDoc as any).updates;
    expect(updates.size).toBe(1);
    expect(updates.keys().next().value).toBe("recordOfObjects.ice cream");
    expect(updates.values().next().value).toEqual({
      rating: 4,
      tags: ["abc"],
    });
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 4,
          tags: ["abc"],
        },
        spinach: {
          rating: 5,
          tags: ["green", "healthy"],
        },
      },
    });
  });

  it("adds an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.recordOfObjects.tacos = { rating: 9, tags: ["crunchy"] };
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 10,
        },
        spinach: {
          rating: 5,
          tags: ["green", "healthy"],
        },
        tacos: {
          rating: 9,
          tags: ["crunchy"],
        },
      },
    });
  });

  it("deletes an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    delete testDoc.w.recordOfObjects.spinach;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 10,
        },
      },
    });
  });

  it("can set all record contents", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.recordOfObjects = {
      tacos: {
        rating: 9,
        tags: ["crunchy"],
      },
    };
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        tacos: {
          rating: 9,
          tags: ["crunchy"],
        },
      },
    });
  });
});

describe("nested records", () => {
  const initialState: TestDataInput = {
    email: "bob@example.com",
    nestedRecords: {
      x: {
        a: 111,
        b: 222,
      },
      y: {
        c: 333,
      },
    },
  };

  it("reads an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect("x" in testDoc.r.nestedRecords).toBe(true);
    expect("a" in testDoc.r.nestedRecords.x).toBe(true);
    expect(testDoc.r.nestedRecords.x.a).toBe(111);
    expect(testDoc.r.nestedRecords.x.b).toBe(222);
    expect(testDoc.r.nestedRecords.y.c).toBe(333);
  });

  it("modifies an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.nestedRecords.x.b = 234;
    testDoc.w.nestedRecords.y = { d: 444 };
    await testDoc.write();
    expect(testDoc.r.nestedRecords.x.b).toBe(234);
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      nestedRecords: {
        x: {
          a: 111,
          b: 234,
        },
        y: {
          d: 444,
        },
      },
    });
  });

  it("adds an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.nestedRecords.y.d = 444;
    testDoc.w.nestedRecords.z = { e: 555 };
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      nestedRecords: {
        x: {
          a: 111,
          b: 222,
        },
        y: {
          c: 333,
          d: 444,
        },
        z: {
          e: 555,
        },
      },
    });
  });

  it("deletes an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    delete testDoc.w.nestedRecords.x.a;
    delete testDoc.w.nestedRecords.y;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      nestedRecords: {
        x: {
          b: 222,
        },
      },
    });
  });
});

describe("array of objects", () => {
  const initialState: TestDataInput = {
    email: "bob@example.com",
    arrayOfObjects: [
      { name: "foo", entries: {} },
      { name: "bar", entries: { a: 111, b: 222 }, favoriteColor: "blue" },
    ],
  };

  it("reads an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect(testDoc.r.arrayOfObjects.length).toBe(2);
    expect(testDoc.r.arrayOfObjects[0].name).toBe("foo");
    expect(testDoc.r.arrayOfObjects[1].name).toBe("bar");
    expect("a" in testDoc.r.arrayOfObjects[1].entries).toBe(true);
    expect(testDoc.r.arrayOfObjects[1].entries.b).toBe(222);
  });

  it("modifies an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.arrayOfObjects[0] = {
      name: "constants",
      entries: { pi: 3.14159, e: 2.71828 },
    };
    testDoc.w.arrayOfObjects[1].name += "bell";
    testDoc.w.arrayOfObjects[1].entries.a = 123;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "constants", entries: { pi: 3.14159, e: 2.71828 } },
        { name: "barbell", entries: { a: 123, b: 222 }, favoriteColor: "blue" },
      ],
    });
  });

  it("adds an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.arrayOfObjects.push({ name: "baz", entries: { c: 333 } });
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "foo", entries: {} },
        { name: "bar", entries: { a: 111, b: 222 }, favoriteColor: "blue" },
        { name: "baz", entries: { c: 333 } },
      ],
    });
  });

  it("deletes an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    delete testDoc.w.arrayOfObjects[0];
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "bar", entries: { a: 111, b: 222 }, favoriteColor: "blue" },
      ],
    });
  });

  it("handles an array index that is out of bounds", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect(delete testDoc.w.arrayOfObjects[99]).toBeTruthy();
  });

  it("fails to delete for malformed indices", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect(() => {
      delete testDoc.w.arrayOfObjects[-99];
    }).toThrow(TypeError);
  });

  it("deletes the correct entry when there are multiple copies", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "A", entries: {} },
        { name: "foo", entries: {} },
        { name: "B", entries: {} },
        { name: "foo", entries: {} },
        { name: "C", entries: {} },
        { name: "foo", entries: {} },
        { name: "D", entries: {} },
        { name: "foo", entries: {} },
        { name: "E", entries: {} },
      ],
    });
    delete testDoc.w.arrayOfObjects[5];
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "A", entries: {} },
        { name: "foo", entries: {} },
        { name: "B", entries: {} },
        { name: "foo", entries: {} },
        { name: "C", entries: {} },
        { name: "D", entries: {} },
        { name: "foo", entries: {} },
        { name: "E", entries: {} },
      ],
    });
  });

  it("removes a field within an entry with the delete operator", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    delete testDoc.w.arrayOfObjects[1].entries.a;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "foo", entries: {} },
        { name: "bar", entries: { b: 222 }, favoriteColor: "blue" },
      ],
    });
  });

  it("removes a field within an entry when set to undefined", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.arrayOfObjects[1].favoriteColor = undefined;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "foo", entries: {} },
        { name: "bar", entries: { a: 111, b: 222 } },
      ],
    });
  });

  it("can set the array contents", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.arrayOfObjects = [
      { name: "baz", entries: {} },
      { name: "qux", entries: { a: 111, b: 222 } },
    ];
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "baz", entries: {} },
        { name: "qux", entries: { a: 111, b: 222 } },
      ],
    });
  });

  it("truncates an array using its length property", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.arrayOfObjects.length = 1;
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [{ name: "foo", entries: {} }],
    });
  });
});

describe("array of discriminating unions", () => {
  const initialState: TestDataInput = {
    email: "bob@example.com",
    arrayOfDiscUnions: [
      { type: "A", someNumber: 123 },
      { type: "B", someString: "yo" },
      { type: "C", someBoolean: true },
    ],
  };

  it("reads entries", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect(testDoc.r.arrayOfDiscUnions).toBeDefined();
    expect(testDoc.r.arrayOfDiscUnions!.length).toBe(3);
    expect(testDoc.r.arrayOfDiscUnions![0].type).toBe("A");
    expect((testDoc.r.arrayOfDiscUnions![0] as any).someNumber).toBe(123);
    expect(testDoc.r.arrayOfDiscUnions![1].type).toBe("B");
    expect((testDoc.r.arrayOfDiscUnions![1] as any).someString).toBe("yo");
    expect(testDoc.r.arrayOfDiscUnions![2].type).toBe("C");
    expect((testDoc.r.arrayOfDiscUnions![2] as any).someBoolean).toBe(true);
  });

  it("updates entries and changes type", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    const entry0 = testDoc.w.arrayOfDiscUnions![0];
    expect(entry0.type).toBe("A");
    if (entry0.type === "A") {
      entry0.someNumber = 456;
    }
    testDoc.w.arrayOfDiscUnions![1] = {
      type: "C",
      someBoolean: false,
    };
    testDoc.w.arrayOfDiscUnions!.push({
      type: "B",
      someString: "hello",
    });
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfDiscUnions: [
        { type: "A", someNumber: 456 },
        { type: "C", someBoolean: false },
        { type: "C", someBoolean: true },
        { type: "B", someString: "hello" },
      ],
    });
  });
});

describe("createNewDoc", () => {
  const initialState: TestDataInput = {
    email: "bob@example.com",
  };

  it("does not provide an ID or doc ref until write is called", async () => {
    const testDoc = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState,
    );
    expect(() => testDoc.id).toThrow("id can only be accessed after");
    expect(() => testDoc.docRef).toThrow("docRef can only be accessed after");
  });

  it("adds a document without a specified ID", async () => {
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState,
    ).write();
    expect(testDoc.id).toMatch(/^[A-Za-z0-9]{12,}$/);
    expect(testDoc.docRef).toBeDefined();
    const result = testDoc.docRef
      ? (await getDoc(testDoc.docRef)).data()
      : undefined;
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: {},
      arrayOfObjects: [],
    });
  });

  it("adds a document with a given ID", async () => {
    const docID = "abcdef123456";
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      doc(testCollection, docID),
      initialState,
    ).write();
    expect(testDoc.id).toBe(docID);
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: {},
      arrayOfObjects: [],
    });
  });

  it("can change an added document, before and after writing", async () => {
    const testDoc = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState,
    );
    testDoc.w.recordOfObjects.x = { rating: 5, tags: ["hi"] };
    expect(testDoc.isNew).toBe(true);
    expect(testDoc.isLoaded).toBe(true);
    expect(testDoc.isPendingWrite).toBe(true);
    await testDoc.write();
    expect(testDoc.isPendingWrite).toBe(false);
    const result1 = (await getDoc(testDoc.docRef)).data();
    expect(result1).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: { x: { rating: 5, tags: ["hi"] } },
      arrayOfObjects: [],
    });
    testDoc.w.recordOfPrimitives.a = "bye";
    expect(testDoc.isPendingWrite).toBe(true);
    await testDoc.write();
    expect(testDoc.isPendingWrite).toBe(false);
    const result2 = (await getDoc(testDoc.docRef)).data();
    expect(result2).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: { a: "bye" },
      nestedRecords: {},
      recordOfObjects: { x: { rating: 5, tags: ["hi"] } },
      arrayOfObjects: [],
    });
  });
});

describe("copy", () => {
  const initialState: TestDataInput = {
    email: "bob@example.com",
    recordOfObjects: {
      "ice cream": {
        rating: 10,
      },
      spinach: {
        rating: 5,
        tags: ["green", "healthy"],
      },
    },
  };

  it("performs a deep copy of a document", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState,
    );
    const testDoc2 = testDoc1.copy();
    const iceCream = testDoc2.w.recordOfObjects["ice cream"];
    iceCream.rating = 9;
    iceCream.tags.push("melting");
    await Promise.all([testDoc1.write(), testDoc2.write()]);
    const result1 = (await getDoc(testDoc1.docRef)).data();
    expect(result1).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 10,
          tags: [],
        },
        spinach: {
          rating: 5,
          tags: ["green", "healthy"],
        },
      },
      recordOfPrimitives: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
    const result2 = (await getDoc(testDoc2.docRef)).data();
    expect(result2).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 9,
          tags: ["melting"],
        },
        spinach: {
          rating: 5,
          tags: ["green", "healthy"],
        },
      },
      recordOfPrimitives: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("throws if the copied doc exists but was not loaded", async () => {
    const docRef = await addDoc(testCollection, initialState);
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    expect(() => testDoc.copy()).toThrow();
  });

  it("can copy into a specified collection", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState,
    );
    const testDoc2 = testDoc1.copy(testCollection);
    await Promise.all([testDoc1.write(), testDoc2.write()]);
    const result2 = (await getDoc(testDoc2.docRef)).data();
    expect(result2).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 10,
          tags: [],
        },
        spinach: {
          rating: 5,
          tags: ["green", "healthy"],
        },
      },
      recordOfPrimitives: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("can copy into a specified doc reference", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState,
    );
    const testDoc2 = testDoc1.copy(doc(testCollection, "copy-with-doc-ref"));
    await Promise.all([testDoc1.write(), testDoc2.write()]);
    expect(testDoc2.id).toBe("copy-with-doc-ref");
    const result2 = (await getDoc(testDoc2.docRef)).data();
    expect(result2).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 10,
          tags: [],
        },
        spinach: {
          rating: 5,
          tags: ["green", "healthy"],
        },
      },
      recordOfPrimitives: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("can copy into a specified ID", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      doc(testCollection, "copy-original"),
      initialState,
    );
    const testDoc2 = testDoc1.copy("copy-with-id-string");
    await Promise.all([testDoc1.write(), testDoc2.write()]);
    expect(testDoc2.id).toBe("copy-with-id-string");
    const result2 = (await getDoc(testDoc2.docRef)).data();
    expect(result2).toEqual({
      email: "bob@example.com",
      recordOfObjects: {
        "ice cream": {
          rating: 10,
          tags: [],
        },
        spinach: {
          rating: 5,
          tags: ["green", "healthy"],
        },
      },
      recordOfPrimitives: {},
      nestedRecords: {},
      arrayOfObjects: [],
    });
  });

  it("can copy into a doc given by string[]", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      collection(testCollection, "id-A", "subcol-1"),
      initialState,
    );
    const testDoc2 = testDoc1.copy(["id-B", "copy-with-doc-ids"]);
    expect(testDoc2.docRef.path).toBe(
      "doctests/id-B/subcol-1/copy-with-doc-ids",
    );
  });

  it("can copy into a collection using string[] (for new doc)", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      collection(testCollection, "id-A", "subcol-1"),
      initialState,
    );
    const testDoc2 = await testDoc1.copy(["id-B"]).write();
    expect(testDoc2.docRef.path).toMatch(/^doctests\/id-B\/subcol-1\/[^/]+$/);
  });

  it("can copy into a collection using string[] (existing doc)", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      collection(testCollection, "id-A", "subcol-1"),
      initialState,
    );
    await testDoc1.write();
    const testDoc2 = await testDoc1.copy(["id-B"]).write();
    expect(testDoc2.docRef.path).toMatch(/^doctests\/id-B\/subcol-1\/[^/]+$/);
  });

  it("throws when given string[] with the wrong number of IDs", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      collection(testCollection, "id-A", "subcol-1", "id-B", "subcol-2"),
      initialState,
    );
    expect(() => testDoc1.copy(["A"])).toThrow();
    expect(() => testDoc1.copy(["A", "B", "C", "D"])).toThrow();
  });
});

describe("other zod types", () => {
  it("handles z.any", async () => {
    const schema = z.object({
      anything: z.any(),
      arrayOfAnythings: z.array(z.any()),
    });
    const data: z.infer<typeof schema> = {
      anything: {
        foo: "hello",
        bar: 123,
      },
      arrayOfAnythings: [{ a: { x: 123, y: 234 }, b: 222 }, { c: 333 }],
    };
    const docRef = await addDoc(testCollection, data);
    const testDoc = await new FiretenderDoc(schema, docRef).load();
    expect(testDoc.r).toEqual(data);
    await testDoc.update((data) => {
      data.anything = "I can haz primitive?";
      data.arrayOfAnythings[1] = data.arrayOfAnythings[0];
      const a = data.arrayOfAnythings[1].a;
      data.arrayOfAnythings.push(a);
    });
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      anything: "I can haz primitive?",
      arrayOfAnythings: [
        { a: { x: 123, y: 234 }, b: 222 },
        { a: { x: 123, y: 234 }, b: 222 },
        { x: 123, y: 234 },
      ],
    });
  });

  it("handles enums", async () => {
    const schema = z.object({
      x: z.enum(["a", "b", "c"]),
    });
    const docRef = await addDoc(testCollection, { x: "b" });
    const testDoc = await new FiretenderDoc(schema, docRef).load();
    expect(testDoc.r).toEqual({ x: "b" });
    await testDoc.update((data) => {
      data.x = "c";
    });
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({ x: "c" });
  });

  it("handles nullable fields", async () => {
    const schema = z.object({
      x: z.number().nullable(),
      y: z.number().nullable(),
      z: z.object({ a: z.string(), b: z.string() }).nullable(),
    });
    const docRef = await addDoc(testCollection, {
      x: 111,
      y: null,
      z: { a: "foo", b: "bar" },
    });
    const testDoc = await new FiretenderDoc(schema, docRef).load();
    expect(testDoc.r).toEqual({ x: 111, y: null, z: { a: "foo", b: "bar" } });
    await testDoc.update((data) => {
      data.x = null;
      data.y = 222;
      if (data.z) {
        data.z.b = "baz";
      }
    });
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({ x: null, y: 222, z: { a: "foo", b: "baz" } });
  });

  it("handles discriminating unions", async () => {
    const schema = z.object({
      someUnion: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("x"),
          x: z.object({
            x2: z.string(),
          }),
        }),
        z.object({
          type: z.literal("y"),
          y: z.object({
            y2: z.number(),
          }),
        }),
      ]),
    });
    const docRef = await addDoc(testCollection, {
      someUnion: {
        type: "x",
        x: { x2: "123" },
      },
    });
    const testDoc = await new FiretenderDoc(schema, docRef).load();
    expect(testDoc.r).toEqual({ someUnion: { type: "x", x: { x2: "123" } } });
    await testDoc.update((data) => {
      let x2 = "";
      if (data.someUnion.type === "x") {
        x2 = data.someUnion.x.x2;
      }
      data.someUnion = { type: "y", y: { y2: Number(x2) } };
    });
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({ someUnion: { type: "y", y: { y2: 123 } } });
  });
});

describe("timestamps", () => {
  it("writes Firestore's Timestamp type", async () => {
    const now = new Date();
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      {
        email: "bob@example.com",
        ttl: Timestamp.fromDate(now),
      },
    ).write();
    const doc = await getDoc(testDoc.docRef);
    expect(doc.data()?.ttl.toDate()).toEqual(now);
  });

  it("reads Firestore's Timestamp type", async () => {
    const now = new Date();
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      ttl: Timestamp.fromDate(now),
    });
    expect(testDoc.r.ttl?.toDate()).toEqual(now);
  });

  it("generates server timestamps in new doc", async () => {
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      {
        email: "bob@example.com",
        ttl: serverTimestamp(),
      },
    ).write();
    const doc = await getDoc(testDoc.docRef);
    const millisDiff = Math.abs(doc.data()?.ttl.toMillis() - Date.now());
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
  });

  it("generates server timestamps in existing doc", async () => {
    const pastDate = new Date(2001, 2, 3);
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      {
        email: "bob@example.com",
        ttl: Timestamp.fromDate(pastDate),
      },
    ).write();
    expect((await getDoc(testDoc.docRef)).data()?.ttl.toDate()).toEqual(
      pastDate,
    );
    await testDoc.update((doc) => {
      doc.ttl = serverTimestamp();
    });
    const doc = await getDoc(testDoc.docRef);
    const millisDiff = Math.abs(doc.data()?.ttl.toMillis() - Date.now());
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
  });

  it("provides temporary client-generated timestamps", async () => {
    const now = new Date();
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      {
        email: "bob@example.com",
        ttl: serverTimestampWithClientTime(),
      },
    );

    // Wait 100 ms before writing to avoid coincident timestamps.  The test
    // server runs locally, so this should always work....
    await new Promise((resolve) => setTimeout(resolve, 100));
    await testDoc.write();

    // Was a temp timestamp defined, and is it approximately now?
    const tempTimestamp = testDoc.r.ttl as Timestamp;
    expect(tempTimestamp).toBeDefined();
    let millisDiff = Math.abs(tempTimestamp.toMillis() - now.valueOf());
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.

    // Check that the temp timestamp's polyfills are working.  Note that the
    // firestore-admin version of Timestamp has underscores preceding its
    // seconds and nanoseconds properties.
    expect(
      tempTimestamp.isEqual(
        new Timestamp(
          tempTimestamp.seconds ?? (tempTimestamp as any)._seconds,
          tempTimestamp.nanoseconds ?? (tempTimestamp as any)._nanoseconds,
        ),
      ),
    );
    expect(tempTimestamp.toDate().getTime() === tempTimestamp.toMillis());
    expect(tempTimestamp.toString().length > 0);
    expect(tempTimestamp.valueOf().length > 0);

    // On reading, is there a server timestamp that differs from the temp one?
    await testDoc.load({ force: true });
    const assignedTimestamp = testDoc.r.ttl as Timestamp;
    expect(assignedTimestamp).toBeDefined();
    expect(assignedTimestamp.toMillis() !== tempTimestamp.toMillis());

    // Is the server timestamp approximately now?
    millisDiff = Math.abs(assignedTimestamp.toMillis() - now.valueOf());
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
  });

  it("generates future timestamps", async () => {
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      {
        email: "bob@example.com",
        ttl: futureTimestamp({ days: 30 }),
      },
    ).write();
    const doc = await getDoc(testDoc.docRef);
    const futureMillis = Date.now() + 30 * 86400e3;
    const millisDiff = Math.abs(doc.data()?.ttl.toMillis() - futureMillis);
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
  });
});
