/**
 * Start before testing: firebase emulators:start --project=firetender
 *
 * TODO: #4 nullable tests
 * TODO: #5 zod effects and preprocessing, but disallowing transforms
 * TODO: #6 timestamp tests
 * TODO: #7 enum tests
 * TODO: #8 validation tests: forbid creating, reading, or writing invalid data
 */

import {
  addDoc,
  collection,
  CollectionReference,
  doc,
  getDoc,
  updateDoc,
} from "firebase/firestore";
import { z } from "zod";

import { FiretenderDoc } from "../FiretenderDoc";
import { timestampSchema } from "../Timestamps";
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

let testCollection: CollectionReference;
beforeAll(async () => {
  testCollection = collection(await setupFirestoreEmulator(), "doctests");
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
});

describe("pad", () => {
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

  it("enforces schema rules when a field is set.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(() => {
      testDoc.w.email = "not a valid email";
    }).toThrowError("Invalid email");
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
    testDoc.w.ttl = { seconds: 123, nanoseconds: 456 };
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "alice@example.com",
      ttl: {
        seconds: 123,
        nanoseconds: 456,
      },
    });
  });
});

describe("record of primitives", () => {
  const initialState = {
    email: "bob@example.com",
    recordOfPrimitives: { foo: "xyz" },
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
      recordOfPrimitives: { foo: "abc" },
    });
  });

  it("adds an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.w.recordOfPrimitives.bar = "abc";
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: { foo: "xyz", bar: "abc" },
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
    // // in another test:
    // testDoc.w.arrayOfObjects = [
    //   { name: "baz", entries: {} },
    //   { name: "qux", entries: { a: 111, b: 222 } },
    // ];
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
});

describe("createNewDoc", () => {
  const initialState = {
    email: "bob@example.com",
  };

  it("does not provide a doc ref until write is called.", async () => {
    const testDoc = FiretenderDoc.createNewDoc(
      testDataSchema,
      testCollection,
      initialState
    );
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
    expect(testDoc.id).toEqual(docID);
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
    await testDoc.write();
    const result1 = (await getDoc(testDoc.docRef)).data();
    expect(result1).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: { x: { rating: 5, tags: ["hi"] } },
      arrayOfObjects: [],
    });
    testDoc.w.recordOfPrimitives.a = "bye";
    await testDoc.write();
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
});

afterAll(async () => {
  await cleanupFirestoreEmulator();
});
