import { z } from "zod";

import {
  addDoc,
  collection,
  doc,
  Firestore,
  FIRESTORE_DEPS_TYPE,
  getDoc,
  serverTimestamp,
  setDoc,
  where,
} from "../firestore-deps.js";
import { FiretenderCollection } from "../FiretenderCollection.js";
import { timestampSchema } from "../timestamps.js";
import {
  cleanupFirestoreEmulator,
  getFirestoreEmulator,
} from "./firestore-emulator.js";

const testSchema = z.object({
  foo: z.string(),
  bar: z.number().min(0).optional(),
  ttl: timestampSchema.optional(),
});

const collectionName = "coltests";
let firestore: Firestore;

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(86400e3); // If debugging, set the test timeout to 24 hours.
}

beforeAll(async () => {
  firestore = await getFirestoreEmulator();
});

afterAll(cleanupFirestoreEmulator);

describe("newDoc", () => {
  it("creates a doc with the given ID", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" },
    );
    const testDoc = testCollection.newDoc("111");
    expect(testDoc.id).toBe("111");
    expect(testDoc.r).toEqual({ foo: "hello" });
  });

  it("creates a doc without an ID", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" },
    );
    const testDoc = testCollection.newDoc();
    expect(() => testDoc.id).toThrow();
    expect(testDoc.r).toEqual({ foo: "hello" });
  });

  it("creates a doc in a subcollection", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      [collectionName, "subcollection"],
      { foo: "hello" },
    );
    const testDoc = testCollection.newDoc(["abc", "xyz"]);
    expect(testDoc.id).toBe("xyz");
    expect(testDoc.docRef.path).toBe(`${collectionName}/abc/subcollection/xyz`);
  });

  it("fails if an ID for a parent collection is missing", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      [collectionName, "subcollection"],
      { foo: "hello" },
    );
    expect(() => testCollection.newDoc()).toThrow("requires an ID");
  });

  it("merges given initial field values into the defaults", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" },
    );
    const testDoc = testCollection.newDoc(undefined, { bar: 123 });
    expect(testDoc.r).toEqual({ foo: "hello", bar: 123 });
  });

  it("takes a factory method for the initial data", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      () => ({ foo: "hello" }),
    );
    const testDoc = testCollection.newDoc(undefined, { bar: 123 });
    expect(testDoc.r).toEqual({ foo: "hello", bar: 123 });
  });

  it("fails in readonly mode", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" },
      { readonly: true },
    );
    expect(() => testCollection.newDoc()).toThrow(
      "Cannot create new docs in readonly mode.",
    );
  });
});

describe("existingDoc", () => {
  it("wraps a doc in a collection", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" },
    );
    const testDoc = testCollection.existingDoc("xyz");
    expect(testDoc.id).toBe("xyz");
  });

  it("wraps a doc in a subcollection", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      [collectionName, "subcollection"],
      { foo: "hello" },
    );
    const testDoc = testCollection.existingDoc(["abc", "xyz"]);
    expect(testDoc.id).toBe("xyz");
    expect(testDoc.docRef.path).toBe(`${collectionName}/abc/subcollection/xyz`);
  });

  it("fails if an ID for a parent collection is missing", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      [collectionName, "subcollection"],
      { foo: "hello" },
    );
    expect(() => testCollection.existingDoc("abc")).toThrow(
      "requires a full ID path",
    );
  });
});

describe("query functions", () => {
  // Borrowing an example from the Firestore how-to guide ...
  // https://cloud.google.com/firestore/docs/how-to
  const citySchema = z.object({
    name: z.string(),
    state: z.string().nullable(),
    country: z.string(),
    capital: z.boolean(),
    population: z.number(),
    regions: z.array(z.string()),
  });
  const cityLandmarkSchema = z.object({
    name: z.string(),
    type: z.string(),
  });
  let cityCollection: FiretenderCollection<typeof citySchema>;
  let cityLandmarkCollection: FiretenderCollection<typeof cityLandmarkSchema>;

  beforeAll(async () => {
    const citiesRef = collection(firestore, "cities");
    await Promise.all([
      setDoc(doc(citiesRef, "SF"), {
        name: "San Francisco",
        state: "CA",
        country: "USA",
        capital: false,
        population: 860000,
        regions: ["west_coast", "norcal"],
      }),
      setDoc(doc(citiesRef, "LA"), {
        name: "Los Angeles",
        state: "CA",
        country: "USA",
        capital: false,
        population: 3900000,
        regions: ["west_coast", "socal"],
      }),
      setDoc(doc(citiesRef, "DC"), {
        name: "Washington, D.C.",
        state: null,
        country: "USA",
        capital: true,
        population: 680000,
        regions: ["east_coast"],
      }),
      setDoc(doc(citiesRef, "TOK"), {
        name: "Tokyo",
        state: null,
        country: "Japan",
        capital: true,
        population: 9000000,
        regions: ["kanto", "honshu"],
      }),
      setDoc(doc(citiesRef, "BJ"), {
        name: "Beijing",
        state: null,
        country: "China",
        capital: true,
        population: 21500000,
        regions: ["jingjinji", "hebei"],
      }),
    ]);
    await Promise.all([
      addDoc(collection(citiesRef, "SF", "landmarks"), {
        name: "Golden Gate Bridge",
        type: "bridge",
      }),
      addDoc(collection(citiesRef, "SF", "landmarks"), {
        name: "Legion of Honor",
        type: "museum",
      }),
      addDoc(collection(citiesRef, "LA", "landmarks"), {
        name: "Griffith Park",
        type: "park",
      }),
      addDoc(collection(citiesRef, "LA", "landmarks"), {
        name: "The Getty",
        type: "museum",
      }),
      addDoc(collection(citiesRef, "DC", "landmarks"), {
        name: "Lincoln Memorial",
        type: "memorial",
      }),
      addDoc(collection(citiesRef, "DC", "landmarks"), {
        name: "National Air and Space Museum",
        type: "museum",
      }),
      addDoc(collection(citiesRef, "TOK", "landmarks"), {
        name: "Ueno Park",
        type: "park",
      }),
      addDoc(collection(citiesRef, "TOK", "landmarks"), {
        name: "National Museum of Nature and Science",
        type: "museum",
      }),
      addDoc(collection(citiesRef, "BJ", "landmarks"), {
        name: "Jingshan Park",
        type: "park",
      }),
      addDoc(collection(citiesRef, "BJ", "landmarks"), {
        name: "Beijing Ancient Observatory",
        type: "museum",
      }),
    ]);
    cityCollection = new FiretenderCollection(
      citySchema,
      firestore,
      "cities",
      {},
    );
    cityLandmarkCollection = new FiretenderCollection(
      cityLandmarkSchema,
      firestore,
      ["cities", "landmarks"],
      {},
    );
  });

  describe("getAllDocs", () => {
    it("returns all docs in a collection", async () => {
      const docs = await cityCollection.getAllDocs();
      expect(docs.length).toBe(5);
      expect(docs[0].r).toEqual({
        name: "Beijing",
        state: null,
        country: "China",
        capital: true,
        population: 21500000,
        regions: ["jingjinji", "hebei"],
      });
      expect(docs[4].r).toEqual({
        name: "Tokyo",
        state: null,
        country: "Japan",
        capital: true,
        population: 9000000,
        regions: ["kanto", "honshu"],
      });
    });

    it("fails when called on a subcollection without parent ID", async () => {
      await expect(cityLandmarkCollection.getAllDocs()).rejects.toThrow(
        "requires the IDs of all parent collections",
      );
    });

    it("provides context on errors", async () => {
      const nonexistentCollection = new FiretenderCollection(
        testSchema,
        firestore,
        "no-collection-here",
      );
      // Admin can read anywhere, so this test does not throw an error.
      if (FIRESTORE_DEPS_TYPE === "admin") return;
      await expect(nonexistentCollection.getAllDocs()).rejects.toThrow();
      try {
        await nonexistentCollection.getAllDocs();
      } catch (error: any) {
        expect(error.firetenderContext).toEqual({
          call: "getDocs",
          ref: "no-collection-here",
        });
      }
    });

    it("applies patches to the raw data", async () => {
      cityCollection.addBeforeParseHook((data) => {
        if (data.name === "Los Angeles") {
          data.regions?.push("home");
        }
      });
      cityCollection.addBeforeParseHook((data) => {
        // Second patcher should run after the first.
        if (data.name === "Los Angeles") {
          data.regions?.sort();
        }
      });
      const docs = await cityCollection.getAllDocs();
      const iLA = docs.findIndex((d) => d.id === "LA");
      expect(iLA).toBeGreaterThan(-1);
      expect(docs[iLA].r.regions).toEqual(["home", "socal", "west_coast"]);
    });

    it("applies patches to the parsed data", async () => {
      cityCollection.addAfterParseHook((data) => {
        if (data.name === "Washington, D.C.") {
          data.regions?.push("capital");
        }
      });
      cityCollection.addAfterParseHook((data) => {
        // Second patcher should run after the first.
        if (data.name === "Washington, D.C.") {
          data.regions?.sort();
        }
      });
      const docs = await cityCollection.getAllDocs();
      const iLA = docs.findIndex((d) => d.id === "DC");
      expect(iLA).toBeGreaterThan(-1);
      expect(docs[iLA].r.regions).toEqual(["capital", "east_coast"]);
    });
  });

  describe("query", () => {
    it("performs a simple query on a collection", async () => {
      const docs = await cityCollection.query(where("population", ">=", 1e6));
      expect(docs.map((d) => d.r.name).sort()).toEqual([
        "Beijing",
        "Los Angeles",
        "Tokyo",
      ]);
    });

    it("performs a compound query on a collection", async () => {
      const docs = await cityCollection.query(
        where("population", ">=", 1e6),
        where("regions", "array-contains", "west_coast"),
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual(["Los Angeles"]);
    });

    it("performs a simple query on a subcollection", async () => {
      const docs = await cityLandmarkCollection.query(
        "LA",
        where("type", "==", "park"),
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual(["Griffith Park"]);
    });

    it("takes an array for the ID path", async () => {
      const docs = await cityLandmarkCollection.query(
        ["BJ"],
        where("type", "==", "museum"),
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual([
        "Beijing Ancient Observatory",
      ]);
    });

    it("performs a simple query across a subcollection group", async () => {
      const docs = await cityLandmarkCollection.query(
        where("type", "==", "museum"),
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual([
        "Beijing Ancient Observatory",
        "Legion of Honor",
        "National Air and Space Museum",
        "National Museum of Nature and Science",
        "The Getty",
      ]);
    });

    it("provides context on errors", async () => {
      // Admin can read anywhere, so this test does not throw an error.
      if (FIRESTORE_DEPS_TYPE === "admin") return;
      const nonexistentCollection = new FiretenderCollection(
        testSchema,
        firestore,
        "no-collection-here",
      );
      const whereClause = where("not-an-actual-field", "==", "foo");
      await expect(nonexistentCollection.query(whereClause)).rejects.toThrow();
      try {
        await nonexistentCollection.query(whereClause);
      } catch (error: any) {
        expect(error.firetenderContext).toEqual({
          call: "getDocs",
        });
      }
    });

    it("applies patches to the data", async () => {
      cityLandmarkCollection.addBeforeParseHook((data) => {
        if (data.name === "The Getty") {
          data.name = "The Getty Center";
        }
        return false;
      });
      const docs = await cityLandmarkCollection.query(
        "LA",
        where("type", "==", "museum"),
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual(["The Getty Center"]);
    });

    it("works with timestamps", async () => {
      // Write doc with a server timestamp.  Confirm timestamp is set.
      const uniqueFoo = `foo-${Date.now()}`;
      const docRef = (
        await new FiretenderCollection(testSchema, firestore, collectionName)
          .newDoc(undefined, { foo: uniqueFoo, bar: 1, ttl: serverTimestamp() })
          .write()
      ).docRef;
      const doc = await getDoc(docRef);
      const serverTimestampMillis = doc.data()?.ttl.toMillis();
      const millisDiff = Math.abs(serverTimestampMillis - Date.now());
      expect(millisDiff).toBeLessThan(10000); // Less than 10 seconds apart.
      // Load doc via a collection with a patcher.  Confirm the patcher works and
      // the timestamp remains.
      const collection = new FiretenderCollection(
        testSchema,
        firestore,
        collectionName,
        undefined,
        {
          beforeParse: [
            (data: any) => {
              data.bar = 2;
            },
          ],
        },
      );
      const results = await collection.query(where("foo", "==", uniqueFoo));
      expect(results.length).toBe(1);
      const testDoc = results[0];
      expect(testDoc.r.foo).toBe(uniqueFoo);
      expect(testDoc.r.bar).toBe(2);
      expect(testDoc.r.ttl?.toMillis()).toBe(serverTimestampMillis);
    });
  });
});

describe("delete", () => {
  it("deletes a document in a collection", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "delete-doc-in-collection" },
    );
    const testDoc = await testCollection.newDoc().write();
    const docsBeforeDelete = await testCollection.query(
      where("foo", "==", "delete-doc-in-collection"),
    );
    expect(docsBeforeDelete.map((d) => d.r.foo).sort()).toEqual([
      "delete-doc-in-collection",
    ]);
    await testCollection.delete(testDoc.id);
    const docsAfterDelete = await testCollection.query(
      where("foo", "==", "delete-doc-in-collection"),
    );
    expect(docsAfterDelete.map((d) => d.r.foo).sort()).toEqual([]);
  });

  it("throws for an incomplete doc ID", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
    );
    await expect(testCollection.delete([])).rejects.toThrow(
      "requires the full ID path",
    );
  });

  it("throws for failed delete", async () => {
    if (FIRESTORE_DEPS_TYPE === "admin") return; // Admin can delete anywhere.
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      "bad-collection-name",
    );
    await expect(testCollection.delete("some-id")).rejects.toThrow(
      "PERMISSION_DENIED",
    );
  });
});

describe("makeCollectionRef", () => {
  it("throws for the wrong number of IDs", async () => {
    const testCollection = new FiretenderCollection(testSchema, firestore, [
      collectionName,
      "subcol-A",
      "subcol-B",
    ]);
    expect(() => testCollection.makeCollectionRef(["123"])).toThrow();
    expect(() =>
      testCollection.makeCollectionRef(["123", "456", "789"]),
    ).toThrow();
  });

  it("returns a correct subcollection ref", async () => {
    const testCollection = new FiretenderCollection(testSchema, firestore, [
      collectionName,
      "subcol-A",
      "subcol-B",
    ]);
    const ref = testCollection.makeCollectionRef(["123", "456"]);
    expect(ref.path).toBe("coltests/123/subcol-A/456/subcol-B");
  });

  it("returns a correct top-level collection ref", async () => {
    const testCollection = new FiretenderCollection(testSchema, firestore, [
      collectionName,
    ]);
    const ref = testCollection.makeCollectionRef();
    expect(ref.path).toBe("coltests");
  });
});

describe("makeDocRef", () => {
  it("throws for the wrong number of IDs", async () => {
    const testCollection = new FiretenderCollection(testSchema, firestore, [
      collectionName,
      "subcol-A",
      "subcol-B",
    ]);
    expect(() => testCollection.makeDocRef(["123", "456"])).toThrow();
    expect(() =>
      testCollection.makeDocRef(["123", "456", "789", "abc"]),
    ).toThrow();
  });

  it("returns an appropriate doc ref", async () => {
    const testCollection = new FiretenderCollection(testSchema, firestore, [
      collectionName,
      "subcol-A",
      "subcol-B",
    ]);
    const ref = testCollection.makeDocRef(["123", "456", "789"]);
    expect(ref.path).toBe("coltests/123/subcol-A/456/subcol-B/789");
  });
});

describe("createBatch", () => {
  it("creates a batch of docs", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
    );
    const docs = await testCollection.createBatch([
      ["create-batch-doc0", { foo: "hello" }],
      ["create-batch-doc1", { foo: "world" }],
    ]);
    expect(docs[0].id).toBe("create-batch-doc0");
    expect(docs[0].r).toEqual({ foo: "hello" });
    expect(docs[1].id).toBe("create-batch-doc1");
    expect(docs[1].r).toEqual({ foo: "world" });
    expect((await getDoc(docs[0].docRef)).data()).toEqual({ foo: "hello" });
    expect((await getDoc(docs[1].docRef)).data()).toEqual({ foo: "world" });
  });

  it("throws for incomplete doc IDs", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
    );
    await expect(
      testCollection.createBatch([[[], { foo: "hello" }]]),
    ).rejects.toThrow("incomplete ID");
  });

  it("throws for parsing errors", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
    );
    await expect(
      testCollection.createBatch([["bad-data", { foo: "xyz", bar: -1 }]]),
    ).rejects.toThrow();
  });

  it("throws for failed commits", async () => {
    if (FIRESTORE_DEPS_TYPE === "admin") return; // Admin can create anywhere.
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      "bad-collection-name",
    );
    await expect(
      testCollection.createBatch([["some-id", { foo: "xyz" }]]),
    ).rejects.toThrow("PERMISSION_DENIED");
  });
});

describe("deleteBatch", () => {
  it("deletes a batch of docs", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
    );
    await testCollection.createBatch([
      ["delete-batch-doc0", { foo: "delete-batch-test" }],
      ["delete-batch-doc1", { foo: "delete-batch-test" }],
    ]);
    expect(
      (await testCollection.query(where("foo", "==", "delete-batch-test")))
        .length,
    ).toBe(2);
    await testCollection.deleteBatch([
      "delete-batch-doc0",
      "delete-batch-doc1",
    ]);
    expect(
      (await testCollection.query(where("foo", "==", "delete-batch-test")))
        .length,
    ).toBe(0);
  });

  it("throws for incomplete doc IDs", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
    );
    await expect(testCollection.deleteBatch([[]])).rejects.toThrow(
      "incomplete ID",
    );
  });

  it("throws for failed commits", async () => {
    if (FIRESTORE_DEPS_TYPE === "admin") return; // Admin can delete anywhere.
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      "bad-collection-name",
    );
    await expect(testCollection.deleteBatch(["some-id"])).rejects.toThrow(
      "PERMISSION_DENIED",
    );
  });
});
