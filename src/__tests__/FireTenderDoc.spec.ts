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
import { type DocumentData } from "@firebase/firestore";
import { z } from "zod";
import { DocWrapper } from "../DocWrapper";

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

const testDataWrapper = new DocWrapper(testDataSchema);

let testCollection: CollectionReference<DocumentData>;

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
  const fp = testDataWrapper.wrapExisting(docRef);
  await fp.load();
  return fp;
}

beforeAll(async () => {
  await setupFirestoreEmulator();
});

describe("load", () => {
  it("must be called before referencing the accessors.", async () => {
    const fp = testDataWrapper.wrapExisting(doc(testCollection, "foo"));
    expect(() => fp.ro.email).toThrowError(
      "You must call load() before using the .ro accessor."
    );
    expect(() => fp.rw.email).toThrowError(
      "You must call load() before using the .rw accessor."
    );
  });

  it("throws for a non-existent doc.", async () => {
    const fp = testDataWrapper.wrapExisting(doc(testCollection, "foo"));
    await expect(fp.load()).rejects.toThrowError("Document does not exist.");
  });

  it("throws for a created but not yet written doc.", async () => {
    const fp = testDataWrapper.createNew(testCollection, {
      email: "bob@example.com",
    });
    await expect(fp.load()).rejects.toThrowError(
      "should not be called for new documents."
    );
  });

  it("throws for an invalid doc.", async () => {
    const docRef = await addDoc(testCollection, {}); // Missing email.
    const fp = testDataWrapper.wrapExisting(docRef);
    await expect(fp.load()).rejects.toThrowError('"message": "Required"');
  });

  it("always reads from Firestore if force is set.", async () => {
    const fp = await createAndLoadDoc({
      email: "bob@example.com",
    });
    // After a change in Firestore, fp does not show it until a forced load.
    await updateDoc(fp.docRef, { email: "alice@example.com" });
    await fp.load(); // Does nothing.
    expect(fp.ro.email).toBe("bob@example.com");
    await fp.load(true); // Forces load.
    expect(fp.ro.email).toBe("alice@example.com");
  });
});

describe("pad", () => {
  it("reads a primitive field.", async () => {
    const fp = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(fp.ro.email).toBe("bob@example.com");
  });

  it("does not contain a missing optional field.", async () => {
    const fp = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect("ttl" in fp.ro).toBe(false);
  });

  it("enforces schema rules when a field is set.", async () => {
    const fp = await createAndLoadDoc({
      email: "bob@example.com",
    });
    expect(() => {
      fp.rw.email = "not a valid email";
    }).toThrowError("Invalid email");
  });
});

describe("write", () => {
  it("sets a primitive field and updates Firestore.", async () => {
    const fp = await createAndLoadDoc({
      email: "bob@example.com",
    });
    await fp.write(); // Should be a no-op since we haven't changed anything.
    fp.rw.email = "alice@example.com";
    expect(fp.ro.email).toBe("alice@example.com");
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
    expect(result).toEqual({ email: "alice@example.com" });
  });

  it("can update multiple fields.", async () => {
    const fp = await createAndLoadDoc({
      email: "bob@example.com",
    });
    fp.rw.email = "alice@example.com";
    fp.rw.ttl = { seconds: 123, nanoseconds: 456 };
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    expect(fp.ro.recordOfPrimitives.foo).toBe("xyz");
  });

  it("modifies an existing entry.", async () => {
    const fp = await createAndLoadDoc(initialState);
    fp.rw.recordOfPrimitives.foo = "abc";
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: { foo: "abc" },
    });
  });

  it("adds an entry.", async () => {
    const fp = await createAndLoadDoc(initialState);
    fp.rw.recordOfPrimitives.bar = "abc";
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: { foo: "xyz", bar: "abc" },
    });
  });

  it("deletes an entry.", async () => {
    const fp = await createAndLoadDoc({
      email: "bob@example.com",
      recordOfPrimitives: { foo: "xyz" },
    });
    delete fp.rw.recordOfPrimitives.foo;
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    expect("ice cream" in fp.ro.recordOfObjects).toBe(true);
    expect(fp.ro.recordOfObjects["ice cream"].rating).toBe(10);
    expect(fp.ro.recordOfObjects["ice cream"].tags.length).toBe(0);
    expect(fp.ro.recordOfObjects.spinach.tags.includes("green")).toBe(true);
  });

  it("modifies an entry.", async () => {
    const fp = await createAndLoadDoc(initialState);
    fp.rw.recordOfObjects["ice cream"] = {
      rating: 8,
      tags: ["too much lactose"],
    };
    fp.rw.recordOfObjects.spinach.rating = 6;
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    fp.rw.recordOfObjects.tacos = { rating: 9, tags: ["crunchy"] };
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    delete fp.rw.recordOfObjects.spinach;
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    expect("x" in fp.ro.nestedRecords).toBe(true);
    expect("a" in fp.ro.nestedRecords.x).toBe(true);
    expect(fp.ro.nestedRecords.x.a).toBe(111);
    expect(fp.ro.nestedRecords.x.b).toBe(222);
    expect(fp.ro.nestedRecords.y.c).toBe(333);
  });

  it("modifies an entry.", async () => {
    const fp = await createAndLoadDoc(initialState);
    fp.rw.nestedRecords.x.b = 234;
    fp.rw.nestedRecords.y = { d: 444 };
    await fp.write();
    expect(fp.ro.nestedRecords.x.b).toBe(234);
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    fp.rw.nestedRecords.y.d = 444;
    fp.rw.nestedRecords.z = { e: 555 };
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    delete fp.rw.nestedRecords.x.a;
    delete fp.rw.nestedRecords.y;
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    expect(fp.ro.arrayOfObjects.length).toBe(2);
    expect(fp.ro.arrayOfObjects[0].name).toBe("foo");
    expect(fp.ro.arrayOfObjects[1].name).toBe("bar");
    expect("a" in fp.ro.arrayOfObjects[1].entries).toBe(true);
    expect(fp.ro.arrayOfObjects[1].entries.b).toBe(222);
  });

  it("modifies an entry.", async () => {
    const fp = await createAndLoadDoc(initialState);
    fp.rw.arrayOfObjects[0] = {
      name: "constants",
      entries: { pi: 3.14159, e: 2.71828 },
    };
    fp.rw.arrayOfObjects[1].name += "bell";
    fp.rw.arrayOfObjects[1].entries.a = 123;
    // // in another test:
    // fp.rw.arrayOfObjects = [
    //   { name: "baz", entries: {} },
    //   { name: "qux", entries: { a: 111, b: 222 } },
    // ];
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [
        { name: "constants", entries: { pi: 3.14159, e: 2.71828 } },
        { name: "barbell", entries: { a: 123, b: 222 } },
      ],
    });
  });

  it("adds an entry", async () => {
    const fp = await createAndLoadDoc(initialState);
    fp.rw.arrayOfObjects.push({ name: "baz", entries: { c: 333 } });
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
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
    const fp = await createAndLoadDoc(initialState);
    delete fp.rw.arrayOfObjects[0];
    await fp.write();
    const result = (await getDoc(fp.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      arrayOfObjects: [{ name: "bar", entries: { a: 111, b: 222 } }],
    });
  });

  it("fails to delete if index is out of bounds.", async () => {
    const fp = await createAndLoadDoc(initialState);
    expect(() => {
      delete fp.rw.arrayOfObjects[99];
    }).toThrow(RangeError);
  });
});

describe("createDoc", () => {
  const initialState = {
    email: "bob@example.com",
  };

  it("does not provide a doc ref until write is called.", async () => {
    const fp = testDataWrapper.createNew(testCollection, initialState);
    expect(() => fp.docRef).toThrowError("docRef can only be accessed after");
  });

  it("adds a document without a specified ID.", async () => {
    const fp = testDataWrapper.createNew(testCollection, initialState);
    await fp.write();
    expect(fp.id).toMatch(/^[A-Za-z0-9]{12,}$/);
    expect(fp.docRef).toBeDefined();
    const result = fp.docRef ? (await getDoc(fp.docRef)).data() : undefined;
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
    const fp = testDataWrapper.createNew(
      doc(testCollection, docID),
      initialState
    );
    await fp.write();
    expect(fp.id).toEqual(docID);
    const result = (await getDoc(fp.docRef)).data();
    expect(result).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: {},
      arrayOfObjects: [],
    });
  });

  it("can change an added document, before and after writing.", async () => {
    const fp = testDataWrapper.createNew(testCollection, initialState);
    fp.rw.recordOfObjects.x = { rating: 5, tags: ["hi"] };
    await fp.write();
    const result1 = (await getDoc(fp.docRef)).data();
    expect(result1).toEqual({
      email: "bob@example.com",
      recordOfPrimitives: {},
      nestedRecords: {},
      recordOfObjects: { x: { rating: 5, tags: ["hi"] } },
      arrayOfObjects: [],
    });
    fp.rw.recordOfPrimitives.a = "bye";
    await fp.write();
    const result2 = (await getDoc(fp.docRef)).data();
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
    const fp1 = testDataWrapper.createNew(testCollection, initialState);
    const fp2 = fp1.copy();
    const iceCream = fp2.rw.recordOfObjects["ice cream"];
    iceCream.rating = 9;
    iceCream.tags.push("melting");
    await Promise.all([fp1.write(), fp2.write()]);
    const result1 = (await getDoc(fp1.docRef)).data();
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
    const result2 = (await getDoc(fp2.docRef)).data();
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
    const fp1 = testDataWrapper.createNew(testCollection, initialState);
    const fp2 = fp1.copy(testCollection);
    await Promise.all([fp1.write(), fp2.write()]);
    const result2 = (await getDoc(fp2.docRef)).data();
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
    const fp1 = testDataWrapper.createNew(testCollection, initialState);
    const fp2 = fp1.copy(doc(testCollection, "copy-with-doc-ref"));
    await Promise.all([fp1.write(), fp2.write()]);
    expect(fp2.id).toBe("copy-with-doc-ref");
    const result2 = (await getDoc(fp2.docRef)).data();
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
    const fp1 = testDataWrapper.createNew(
      doc(testCollection, "copy-original"),
      initialState
    );
    const fp2 = fp1.copy("copy-with-id-string");
    await Promise.all([fp1.write(), fp2.write()]);
    expect(fp2.id).toBe("copy-with-id-string");
    const result2 = (await getDoc(fp2.docRef)).data();
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
