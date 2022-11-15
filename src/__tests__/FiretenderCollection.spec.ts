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
      [firestore, "cities"],
      {}
    );
    cityLandmarkCollection = new FiretenderCollection(
      cityLandmarkSchema,
      [firestore, "cities", "landmarks"],
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
        "requires an ID for all collections and subcollections except the last."
      );
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
  });
});

describe("delete", () => {
  it("deletes a document in a collection.", async () => {
    const testCollection = new FiretenderCollection(
      testSchema,
      [firestore, collectionName],
      { foo: "delete-doc-in-collection" }
    );
    const testDoc = await testCollection.createNewDoc().write();
    const docsBeforeDelete = await testCollection.query(
      where("foo", "==", "delete-doc-in-collection")
    );
    expect(docsBeforeDelete.map((d) => d.r.foo).sort()).toEqual([
      "delete-doc-in-collection",
    ]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await testCollection.delete(testDoc.id!);
    const docsAfterDelete = await testCollection.query(
      where("foo", "==", "delete-doc-in-collection")
    );
    expect(docsAfterDelete.map((d) => d.r.foo).sort()).toEqual([]);
  });
});

afterAll(async () => {
  await cleanupFirestoreEmulator();
});
