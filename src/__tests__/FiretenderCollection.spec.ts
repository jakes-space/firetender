import {
  addDoc,
  collection,
  doc,
  Firestore,
  setDoc,
  where,
} from "firebase/firestore";
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

describe("newDoc", () => {
  it("creates a doc with the given ID.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" }
    );
    const testDoc = testCollection.newDoc("111");
    expect(testDoc.id).toBe("111");
    expect(testDoc.r).toEqual({ foo: "hello" });
  });

  it("creates a doc without an ID.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" }
    );
    const testDoc = testCollection.newDoc();
    expect(() => testDoc.id).toThrowError();
    expect(testDoc.r).toEqual({ foo: "hello" });
  });

  it("creates a doc in a subcollection.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      [collectionName, "subcollection"],
      { foo: "hello" }
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const testDoc = testCollection.newDoc(["abc", "xyz"]);
    expect(testDoc.id).toBe("xyz");
    expect(testDoc.docRef.path).toBe(`${collectionName}/abc/subcollection/xyz`);
  });

  it("fails if an ID for a parent collection is missing.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      [collectionName, "subcollection"],
      { foo: "hello" }
    );
    expect(() => testCollection.newDoc()).toThrowError("requires an ID");
  });

  it("merges given initial field values into the defaults.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" }
    );
    const testDoc = testCollection.newDoc(undefined, { bar: 123 });
    expect(testDoc.r).toEqual({ foo: "hello", bar: 123 });
  });

  it("takes a factory method for the initial data.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      () => ({ foo: "hello" })
    );
    const testDoc = testCollection.newDoc(undefined, { bar: 123 });
    expect(testDoc.r).toEqual({ foo: "hello", bar: 123 });
  });
});

describe("existingDoc", () => {
  it("wraps a doc in a collection.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "hello" }
    );
    const testDoc = testCollection.existingDoc("xyz");
    expect(testDoc.id).toBe("xyz");
  });

  it("wraps a doc in a subcollection.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      [collectionName, "subcollection"],
      { foo: "hello" }
    );
    const testDoc = testCollection.existingDoc(["abc", "xyz"]);
    expect(testDoc.id).toBe("xyz");
    expect(testDoc.docRef.path).toBe(`${collectionName}/abc/subcollection/xyz`);
  });

  it("fails if an ID for a parent collection is missing.", () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      [collectionName, "subcollection"],
      { foo: "hello" }
    );
    expect(() => testCollection.existingDoc("abc")).toThrowError(
      "requires a full ID path"
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
      {}
    );
    cityLandmarkCollection = new FiretenderCollection(
      cityLandmarkSchema,
      firestore,
      ["cities", "landmarks"],
      {}
    );
  });

  describe("getAllDocs", () => {
    it("returns all docs in a collection.", async () => {
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

    it("fails when called on a subcollection without parent ID.", async () => {
      await expect(cityLandmarkCollection.getAllDocs()).rejects.toThrowError(
        "requires the IDs of all parent collections"
      );
    });

    it("provides context on errors.", async () => {
      const nonexistentCollection = new FiretenderCollection(
        testSchema,
        firestore,
        "no-collection-here"
      );
      await expect(nonexistentCollection.getAllDocs()).rejects.toThrowError();
      try {
        await nonexistentCollection.getAllDocs();
      } catch (error: any) {
        expect(error.firetenderContext).toEqual({
          call: "getDocs",
          ref: "no-collection-here",
        });
      }
    });
  });

  describe("query", () => {
    it("performs a simple query on a collection.", async () => {
      const docs = await cityCollection.query(where("population", ">=", 1e6));
      expect(docs.map((d) => d.r.name).sort()).toEqual([
        "Beijing",
        "Los Angeles",
        "Tokyo",
      ]);
    });

    it("performs a compound query on a collection.", async () => {
      const docs = await cityCollection.query(
        where("population", ">=", 1e6),
        where("regions", "array-contains", "west_coast")
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual(["Los Angeles"]);
    });

    it("performs a simple query on a subcollection.", async () => {
      const docs = await cityLandmarkCollection.query(
        "LA",
        where("type", "==", "park")
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual(["Griffith Park"]);
    });

    it("takes an array for the ID path.", async () => {
      const docs = await cityLandmarkCollection.query(
        ["BJ"],
        where("type", "==", "museum")
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual([
        "Beijing Ancient Observatory",
      ]);
    });

    it("performs a simple query across a subcollection group.", async () => {
      const docs = await cityLandmarkCollection.query(
        where("type", "==", "museum")
      );
      expect(docs.map((d) => d.r.name).sort()).toEqual([
        "Beijing Ancient Observatory",
        "Legion of Honor",
        "National Air and Space Museum",
        "National Museum of Nature and Science",
        "The Getty",
      ]);
    });

    it("provides context on errors.", async () => {
      const nonexistentCollection = new FiretenderCollection(
        testSchema,
        firestore,
        "no-collection-here"
      );
      const whereClause = where("not-an-actual-field", "==", "foo");
      await expect(
        nonexistentCollection.query(whereClause)
      ).rejects.toThrowError();
      try {
        await nonexistentCollection.query(whereClause);
      } catch (error: any) {
        expect(error.firetenderContext).toEqual({
          call: "getDocs",
        });
      }
    });
  });
});

describe("delete", () => {
  it("deletes a document in a collection.", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      firestore,
      collectionName,
      { foo: "delete-doc-in-collection" }
    );
    const testDoc = await testCollection.newDoc().write();
    const docsBeforeDelete = await testCollection.query(
      where("foo", "==", "delete-doc-in-collection")
    );
    expect(docsBeforeDelete.map((d) => d.r.foo).sort()).toEqual([
      "delete-doc-in-collection",
    ]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await testCollection.delete(testDoc.id);
    const docsAfterDelete = await testCollection.query(
      where("foo", "==", "delete-doc-in-collection")
    );
    expect(docsAfterDelete.map((d) => d.r.foo).sort()).toEqual([]);
  });
});

describe("makeCollectionRef", () => {
  it("throws for the wrong number of IDs", async () => {
    const testCollection = new FiretenderCollection(testSchema, firestore, [
      collectionName,
      "subcol-A",
      "subcol-B",
    ]);
    expect(() => testCollection.makeCollectionRef(["123"])).toThrowError();
    expect(() =>
      testCollection.makeCollectionRef(["123", "456", "789"])
    ).toThrowError();
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
    expect(() => testCollection.makeDocRef(["123", "456"])).toThrowError();
    expect(() =>
      testCollection.makeDocRef(["123", "456", "789", "abc"])
    ).toThrowError();
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

afterAll(async () => {
  await cleanupFirestoreEmulator();
});
