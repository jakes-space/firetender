/**
 * @jest-environment node
 */

/**
 * Start before testing: firebase emulators:start --project=firetender
 *
 * TODO: nullable tests
 * TODO: zod effects and preprocessing, but disallowing transforms
 * TODO: timestamp tests
 * TODO: validation tests: forbid creating, reading, or writing invalid data
 */

import { timestampSchema } from "../Timestamps";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  CollectionReference,
  doc,
  getDoc,
  updateDoc,
} from "firebase/firestore";
import { z } from "zod";
import { FireTenderDoc } from "../FireTenderDoc";

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

const testDocFactory = FireTenderDoc.makeClassFactoryFor(testDataSchema);

let testCollection: CollectionReference;

async function setupFirestoreEmulator(port = 8080) {
  const testEnv = await initializeTestEnvironment({
    firestore: {
      host: "localhost",
      port,
      rules: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents/tests/{testid} {
            allow read, write: if true;
          }
        }
        `,
    },
    projectId: "firetender",
  });
  testCollection = collection(
    testEnv.unauthenticatedContext().firestore(),
    "tests"
  );
}

async function createAndLoadDoc(data: Record<string, unknown>) {
  const docRef = await addDoc(testCollection, data);
  const testDoc = testDocFactory.wrapExistingDoc(docRef);
  await testDoc.load();
  return testDoc;
}

beforeAll(async () => {
  await setupFirestoreEmulator();
});

describe("load", () => {
  it("must be called before referencing the accessors.", async () => {
    const testDoc = testDocFactory.wrapExistingDoc(doc(testCollection, "foo"));
    expect(() => testDoc.ro.email).toThrowError(
      "You must call load() before using the .ro accessor."
    );
    expect(() => testDoc.rw.email).toThrowError(
      "You must call load() before using the .rw accessor."
    );
  });

  it("throws for a non-existent doc.", async () => {
    const testDoc = testDocFactory.wrapExistingDoc(doc(testCollection, "foo"));
    await expect(testDoc.load()).rejects.toThrowError("does not exist");
  });

  it("throws for a created but not yet written doc.", async () => {
    const testDoc = testDocFactory.createNewDoc(testCollection, {
      email: "bob@example.com",
    });
    await expect(testDoc.load()).rejects.toThrowError(
      "should not be called for new documents."
    );
  });

  it("throws for an invalid doc.", async () => {
    const docRef = await addDoc(testCollection, {}); // Missing email.
    const testDoc = testDocFactory.wrapExistingDoc(docRef);
    await expect(testDoc.load()).rejects.toThrowError('"message": "Required"');
  });

  it("always reads from Firestore if force is set.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    // testDoc does not show a change in Firestore until after a forced load.
    await updateDoc(testDoc.docRef, { email: "alice@example.com" });
    await testDoc.load(); // Does nothing.
    expect(testDoc.ro.email).toBe("bob@example.com");
    await testDoc.load(true); // Forces load.
    expect(testDoc.ro.email).toBe("alice@example.com");
  });
});

describe("pad", () => {
  it("reads a primitive field.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(testDoc.ro.email).toBe("bob@example.com");
  });

  it("does not contain a missing optional field.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect("ttl" in testDoc.ro).toBe(false);
  });

  it("enforces schema rules when a field is set.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(() => {
      testDoc.rw.email = "not a valid email";
    }).toThrowError("Invalid email");
  });
});

describe("write", () => {
  it("sets a primitive field and updates Firestore.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    await testDoc.write(); // Should be a no-op since nothing has been changed.
    testDoc.rw.email = "alice@example.com";
    expect(testDoc.ro.email).toBe("alice@example.com");
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({ email: "alice@example.com" });
  });

  it("can update multiple fields.", async () => {
    const testDoc = await createAndLoadDoc({
      email: "bob@example.com",
    });
    testDoc.rw.email = "alice@example.com";
    testDoc.rw.ttl = { seconds: 123, nanoseconds: 456 };
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
    expect(testDoc.ro.recordOfPrimitives.foo).toBe("xyz");
  });

  it("modifies an existing entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.rw.recordOfPrimitives.foo = "abc";
    await testDoc.write();
    const result = (await getDoc(testDoc.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: { foo: "abc" },
    });
  });

  it("adds an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.rw.recordOfPrimitives.bar = "abc";
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
    delete testDoc.rw.recordOfPrimitives.foo;
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
    expect("ice cream" in testDoc.ro.recordOfObjects).toBe(true);
    expect(testDoc.ro.recordOfObjects["ice cream"].rating).toBe(10);
    expect(testDoc.ro.recordOfObjects["ice cream"].tags.length).toBe(0);
    expect(testDoc.ro.recordOfObjects.spinach.tags.includes("green")).toBe(
      true
    );
  });

  it("modifies an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.rw.recordOfObjects["ice cream"] = {
      rating: 8,
      tags: ["too much lactose"],
    };
    testDoc.rw.recordOfObjects.spinach.rating = 6;
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

  it("adds an entry", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.rw.recordOfObjects.tacos = { rating: 9, tags: ["crunchy"] };
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
    delete testDoc.rw.recordOfObjects.spinach;
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
    expect("x" in testDoc.ro.nestedRecords).toBe(true);
    expect("a" in testDoc.ro.nestedRecords.x).toBe(true);
    expect(testDoc.ro.nestedRecords.x.a).toBe(111);
    expect(testDoc.ro.nestedRecords.x.b).toBe(222);
    expect(testDoc.ro.nestedRecords.y.c).toBe(333);
  });

  it("modifies an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.rw.nestedRecords.x.b = 234;
    testDoc.rw.nestedRecords.y = { d: 444 };
    await testDoc.write();
    expect(testDoc.ro.nestedRecords.x.b).toBe(234);
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
    testDoc.rw.nestedRecords.y.d = 444;
    testDoc.rw.nestedRecords.z = { e: 555 };
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
    delete testDoc.rw.nestedRecords.x.a;
    delete testDoc.rw.nestedRecords.y;
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
    expect(testDoc.ro.arrayOfObjects.length).toBe(2);
    expect(testDoc.ro.arrayOfObjects[0].name).toBe("foo");
    expect(testDoc.ro.arrayOfObjects[1].name).toBe("bar");
    expect("a" in testDoc.ro.arrayOfObjects[1].entries).toBe(true);
    expect(testDoc.ro.arrayOfObjects[1].entries.b).toBe(222);
  });

  it("modifies an entry.", async () => {
    const testDoc = await createAndLoadDoc(initialState);
    testDoc.rw.arrayOfObjects[0] = {
      name: "constants",
      entries: { pi: 3.14159, e: 2.71828 },
    };
    testDoc.rw.arrayOfObjects[1].name += "bell";
    testDoc.rw.arrayOfObjects[1].entries.a = 123;
    // // in another test:
    // testDoc.rw.arrayOfObjects = [
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
    testDoc.rw.arrayOfObjects.push({ name: "baz", entries: { c: 333 } });
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
    delete testDoc.rw.arrayOfObjects[0];
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
      delete testDoc.rw.arrayOfObjects[99];
    }).toThrow(RangeError);
  });
});

describe("createDoc", () => {
  const initialState = {
    email: "bob@example.com",
  };

  it("does not provide a doc ref until write is called.", async () => {
    const testDoc = testDocFactory.createNewDoc(testCollection, initialState);
    expect(() => testDoc.docRef).toThrowError(
      "docRef can only be accessed after"
    );
  });

  it("adds a document without a specified ID.", async () => {
    const testDoc = testDocFactory.createNewDoc(testCollection, initialState);
    await testDoc.write();
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
    const testDoc = testDocFactory.createNewDoc(
      doc(testCollection, docID),
      initialState
    );
    await testDoc.write();
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
    const testDoc = testDocFactory.createNewDoc(testCollection, initialState);
    testDoc.rw.recordOfObjects.x = { rating: 5, tags: ["hi"] };
    await testDoc.write();
    const result1 = (await getDoc(testDoc.docRef)).data();
    expect(result1).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: { x: { rating: 5, tags: ["hi"] } },
      arrayOfObjects: [],
    });
    testDoc.rw.recordOfPrimitives.a = "bye";
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
    const testDoc1 = testDocFactory.createNewDoc(testCollection, initialState);
    const testDoc2 = testDoc1.copy();
    const iceCream = testDoc2.rw.recordOfObjects["ice cream"];
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
    const testDoc1 = testDocFactory.createNewDoc(testCollection, initialState);
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
    const testDoc1 = testDocFactory.createNewDoc(testCollection, initialState);
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
    const testDoc1 = testDocFactory.createNewDoc(
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
