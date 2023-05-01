/**
 * Start before testing: firebase emulators:start --project=firetender
 *
 * TODO: #5 zod effects and preprocessing, but disallowing transforms
 */

import { z } from "zod";

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
} from "../firestore-deps";
import { FiretenderDoc } from "../FiretenderDoc";
import {
  futureTimestampDays,
  serverTimestamp,
  serverTimestampWithClientTime,
  timestampSchema,
} from "../timestamps";
import {
  cleanupFirestoreEmulator,
  setupFirestoreEmulator,
} from "./firestore-emulator";

const testDataSchema = z.object({
  email: z.string().email(),
  ttl: timestampSchema.optional(),
  recordOfPrimitives: z.record(z.string()).default({}),
  recordOfObjects: z
    .record(
      z.object({
        rating: z.number(),
        tags: z.array(z.string()).default([]),
      })
    )
    .default({}),
  nestedRecords: z.record(z.record(z.number())).default({}),
  arrayOfObjects: z
    .array(
      z.object({
        name: z.string(),
        // No default({}) for entries, as default or optional values cause
        // issues with array deletion: {name: "x"} != {name: "x", entries: {}}
        entries: z.record(z.number()),
      })
    )
    .default([]),
});

let firestore: Firestore;
let testCollection: CollectionReference;
beforeAll(async () => {
  firestore = await setupFirestoreEmulator();
  testCollection = collection(firestore, "doctests");
});

async function createAndLoadDoc(data: Record<string, unknown>) {
  const docRef = await addDoc(testCollection, data);
  return new FiretenderDoc(testDataSchema, docRef).load();
}

describe("load", () => {
  it("must be called before referencing the accessors.", async () => {
    const testDoc = new FiretenderDoc(
      testDataSchema,
      doc(testCollection, "foo")
    );
    expect(testDoc.isLoaded()).toBe(false);
    expect(() => testDoc.r.email).toThrowError(
      "load() must be called before reading the document."
    );
    expect(() => testDoc.w.email).toThrowError(
      "load() must be called before updating the document."
    );
  });

  it("throws for a non-existent doc.", async () => {
    const testDoc = new FiretenderDoc(
      testDataSchema,
      doc(testCollection, "foo")
    );
    await expect(testDoc.load()).rejects.toThrowError("does not exist");
  });

  it("throws for a created but not yet written doc.", async () => {
    const testDoc = FiretenderDoc.createNewDoc(testDataSchema, testCollection, {
      email: "bob@example.com",
    });
    await expect(testDoc.load()).rejects.toThrowError(
      "should not be called for new documents."
    );
  });

  it("throws for an invalid doc.", async () => {
    const docRef = await addDoc(testCollection, {}); // Missing email.
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    await expect(testDoc.load()).rejects.toThrowError('"message": "Required"');
  });

  it("always reads from Firestore if force is set.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    // testDoc does not show a change in Firestore until after a forced load.
    await updateDoc(testDoc.docRef, { email: "alice@example.com" });
    await testDoc.load(); // Does nothing.
    expect(testDoc.r.email).toBe("bob@example.com");
    await testDoc.load(true); // Forces load.
    expect(testDoc.r.email).toBe("alice@example.com");
  });

  it("waits if a load call is already in progress", async () => {
    const docRef = await addDoc(testCollection, { email: "bob@example.com" });
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    const loadingPromise1 = testDoc.load();
    expect(testDoc.isLoaded()).toBeFalsy();
    const loadingPromise2 = testDoc.load();
    expect(testDoc.isLoaded()).toBeFalsy();
    const loadingPromise3 = testDoc.load();
    expect(testDoc.isLoaded()).toBeFalsy();
    await Promise.all([loadingPromise1, loadingPromise2, loadingPromise3]);
    expect(testDoc.isLoaded()).toBeTruthy();
    expect(testDoc.r.email).toBe("bob@example.com");
  });
});

describe("read-only accessor (.r)", () => {
  it("reads a primitive field.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(testDoc.r.email).toBe("bob@example.com");
  });

  it("does not contain a missing optional field.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect("ttl" in testDoc.r).toBe(false);
  });
});

describe("writable accessor (.w)", () => {
  it("enforces schema rules when a field is set.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(() => {
      testDoc.w.email = "not a valid email";
    }).toThrowError("Invalid email");
  });

  it("allows symbol properties to pass through objects.", async () => {
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

  it("allows symbol properties to pass through arrays.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "foo", entries: {} },
        { name: "bar", entries: { a: 111, b: 222 } },
      ],
    });
    // Converting an Array to a string gets its Symbol.toStringTag property.
    expect(String(testDoc.w.arrayOfObjects)).toBe(
      "[object Object],[object Object]"
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
});

describe("write", () => {
  it("sets a primitive field and updates Firestore.", async () => {
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

  it("can update multiple fields.", async () => {
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

  it("provides context on errors when adding a doc.", async () => {
    // Admin can read anywhere, so this test does not throw an error.
    if (FIRESTORE_DEPS_TYPE === "admin") return;
    const badRef = collection(firestore, "not-in-access-rules");
    const badDoc = FiretenderDoc.createNewDoc(testDataSchema, badRef, {
      email: "bob@example.com",
    });
    await expect(badDoc.write()).rejects.toThrowError();
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

  it("provides context on errors when updating a doc.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    await deleteDoc(testDoc.docRef);
    testDoc.w.email = "alice@example.com";
    await expect(testDoc.write()).rejects.toThrowError();
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
});

describe("record of primitives", () => {
  const initialState = {
    email: "bob@example.com",
    recordOfPrimitives: {
      foo: "xyz",
    },
  };

  it("reads an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect(testDoc.r.recordOfPrimitives.foo).toBe("xyz");
  });

  it("modifies an existing entry.", async () => {
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

  it("adds an entry.", async () => {
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

  it("deletes an entry.", async () => {
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

  it("can set all record contents.", async () => {
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
  const initialState = {
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

  it("reads an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect("ice cream" in testDoc.r.recordOfObjects).toBe(true);
    expect(testDoc.r.recordOfObjects["ice cream"].rating).toBe(10);
    expect(testDoc.r.recordOfObjects["ice cream"].tags.length).toBe(0);
    expect(testDoc.r.recordOfObjects.spinach.tags.includes("green")).toBe(true);
  });

  it("modifies an entry.", async () => {
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

  it("correctly updates a parent field followed by a child.", async () => {
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

  it("correctly updates a child field followed by a parent.", async () => {
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

  it("can set all record contents.", async () => {
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
  const initialState = {
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

  it("reads an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect("x" in testDoc.r.nestedRecords).toBe(true);
    expect("a" in testDoc.r.nestedRecords.x).toBe(true);
    expect(testDoc.r.nestedRecords.x.a).toBe(111);
    expect(testDoc.r.nestedRecords.x.b).toBe(222);
    expect(testDoc.r.nestedRecords.y.c).toBe(333);
  });

  it("modifies an entry.", async () => {
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
  const initialState = {
    email: "bob@example.com",
    arrayOfObjects: [
      { name: "foo", entries: {} },
      { name: "bar", entries: { a: 111, b: 222 } },
    ],
  };

  it("reads an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect(testDoc.r.arrayOfObjects.length).toBe(2);
    expect(testDoc.r.arrayOfObjects[0].name).toBe("foo");
    expect(testDoc.r.arrayOfObjects[1].name).toBe("bar");
    expect("a" in testDoc.r.arrayOfObjects[1].entries).toBe(true);
    expect(testDoc.r.arrayOfObjects[1].entries.b).toBe(222);
  });

  it("modifies an entry.", async () => {
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
        { name: "barbell", entries: { a: 123, b: 222 } },
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
        { name: "bar", entries: { a: 111, b: 222 } },
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
      arrayOfObjects: [{ name: "bar", entries: { a: 111, b: 222 } }],
    });
  });

  it("fails to delete if index is out of bounds.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    expect(() => {
      delete testDoc.w.arrayOfObjects[99];
    }).toThrow(RangeError);
  });

  it("deletes the correct entry when there are multiple copies.", async () => {
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

  it("can set the array contents.", async () => {
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
});

describe("createNewDoc", () => {
  const initialState = {
    email: "bob@example.com",
  };

  it("does not provide an ID or doc ref until write is called.", async () => {
    const testDoc = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState
    );
    expect(() => testDoc.id).toThrowError("id can only be accessed after");
    expect(() => testDoc.docRef).toThrowError(
      "docRef can only be accessed after"
    );
  });

  it("adds a document without a specified ID.", async () => {
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState
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

  it("adds a document with a given ID.", async () => {
    const docID = "abcdef123456";
    const testDoc = await FiretenderDoc.createNewDoc(
      testDataSchema,
      doc(testCollection, docID),
      initialState
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

  it("can change an added document, before and after writing.", async () => {
    const testDoc = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState
    );
    testDoc.w.recordOfObjects.x = { rating: 5, tags: ["hi"] };
    expect(testDoc.isNew()).toBe(true);
    expect(testDoc.isLoaded()).toBe(true);
    expect(testDoc.isPendingWrite()).toBe(true);
    await testDoc.write();
    expect(testDoc.isPendingWrite()).toBe(false);
    const result1 = (await getDoc(testDoc.docRef)).data();
    expect(result1).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: { x: { rating: 5, tags: ["hi"] } },
      arrayOfObjects: [],
    });
    testDoc.w.recordOfPrimitives.a = "bye";
    expect(testDoc.isPendingWrite()).toBe(true);
    await testDoc.write();
    expect(testDoc.isPendingWrite()).toBe(false);
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
  const initialState = {
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

  it("performs a deep copy of a document.", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState
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

  it("throws if the copied doc exists but was not loaded.", async () => {
    const docRef = await addDoc(testCollection, initialState);
    const testDoc = new FiretenderDoc(testDataSchema, docRef);
    expect(() => testDoc.copy()).toThrowError();
  });

  it("can copy into a specified collection.", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState
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

  it("can copy into a specified doc reference.", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState
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

  it("can copy into a specified ID.", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      doc(testCollection, "copy-original"),
      initialState
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

  it("can copy into a doc given by string[].", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      collection(testCollection, "id-A", "subcol-1"),
      initialState
    );
    const testDoc2 = testDoc1.copy(["id-B", "copy-with-doc-ids"]);
    expect(testDoc2.docRef.path).toBe(
      "doctests/id-B/subcol-1/copy-with-doc-ids"
    );
  });

  it("can copy into a collection using string[] (for new doc).", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      collection(testCollection, "id-A", "subcol-1"),
      initialState
    );
    const testDoc2 = await testDoc1.copy(["id-B"]).write();
    expect(testDoc2.docRef.path).toMatch(/^doctests\/id-B\/subcol-1\/[^/]+$/);
  });

  it("can copy into a collection using string[] (existing doc).", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      collection(testCollection, "id-A", "subcol-1"),
      initialState
    );
    await testDoc1.write();
    const testDoc2 = await testDoc1.copy(["id-B"]).write();
    expect(testDoc2.docRef.path).toMatch(/^doctests\/id-B\/subcol-1\/[^/]+$/);
  });

  it("throws when given string[] with the wrong number of IDs.", async () => {
    const testDoc1 = FiretenderDoc.createNewDoc(
      testDataSchema,
      collection(testCollection, "id-A", "subcol-1", "id-B", "subcol-2"),
      initialState
    );
    expect(() => testDoc1.copy(["A"])).toThrowError();
    expect(() => testDoc1.copy(["A", "B", "C", "D"])).toThrowError();
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
      }
    ).write();
    const doc = await getDoc(testDoc.docRef);
    expect(doc.data()?.ttl.toDate()).toEqual(now);
  });

  it("reads Firestore's Timestamp type.", async () => {
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
      }
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
      }
    ).write();
    expect((await getDoc(testDoc.docRef)).data()?.ttl.toDate()).toEqual(
      pastDate
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
      }
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

    // On reading, is there a server timestamp that differs from the temp one?
    await testDoc.load(true); // Force load.
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
        ttl: futureTimestampDays(30),
      }
    ).write();
    const doc = await getDoc(testDoc.docRef);
    const futureMillis = Date.now() + 30 * 86400e3;
    const millisDiff = Math.abs(doc.data()?.ttl.toMillis() - futureMillis);
    expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
  });
});

afterAll(async () => {
  await cleanupFirestoreEmulator();
});
