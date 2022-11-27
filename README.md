# Firetender

The goal of Firetender is to make Firestore documents look (almost) like any
other Typescript objects, reducing boilerplate and conceptual overhead and
providing type safety and data validation.

## Usage

To illustrate, let's run through the basics of defining, creating, modifying,
and copying a Firestore document.

### Initialize Cloud Firestore

The first step is the usual Firestore configuration and initialization.  See
the [Firestore
quickstart](https://firebase.google.com/docs/firestore/quickstart) for details.

```javascript
import { doc, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// TODO: Replace the following with your app's Firebase project configuration.
// See: https://firebase.google.com/docs/web/learn-more#config-object
const firebaseConfig = {
    // ...
};

const app = initializeApp(firebaseConfig);
const firestore = getFirestore(app);
```

### Define a collection and its schema

Firetender uses [Zod](https://github.com/colinhacks/zod) to define the schema
and validation rules for a collection's documents; if you've used Joi or Yup,
you will find Zod very similar.  In the example below, I've defined a schema for
types of pizza.  I was a little hungry when I wrote this.

```javascript
import {
  FiretenderCollection,
  nowTimestamp,
  timestampSchema
} from "firetender";
import { z } from "zod";

const pizzaSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  creationTime: timestampSchema,
  toppings: z.record(
    z.string(),
    z.object({
        isIncluded: z.boolean().default(true),
        surcharge: z.number().positive().optional(),
        placement: z.enum(["left", "right", "entire"]).default("entire"),
      })
      .refine((topping) => topping.isIncluded || topping.surcharge, {
        message: "Toppings that are not included must have a surcharge.",
        path: ["surcharge"],
      })
  ),
  basePrice: z.number().optional(),
  tags: z.array(z.string()).default([]),
});

const pizzaCollection = new FiretenderCollection(
  pizzaSchema,
  [firestore, "pizzas"],
  { creationTime: nowTimestamp() }
);
```

Optional records and arrays should typically use `.default()` to provide an
empty instances when missing.  That isn't required, but it makes accessing these
fields simpler because they will always be defined.  The downside is that empty
fields are not pruned and will appear in Firestore.

### Add a document

Let's add a document to the `pizzas` collection, with an ID of `margherita`.  We
use the collection's `.newDoc()` to produce a `FiretenderDoc` representing a new
document, initialized with validated data.  This object is purely local until it
is written to Firestore by calling `.write()`.  Don't forget to do that.

```javascript
const docRef = doc(db, "pizzas", "margherita");
const pizza = pizzaFactory.newDoc(docRef, {
  name: "Margherita",
  description: "Neapolitan style pizza"
  toppings: { "fresh mozzarella": {}, "fresh basil": {} },
  tags: ["traditional"],
});
await pizza.write();
```

If you don't care about the doc ID, pass a collection reference to `.newDoc()`
and Firestore will assign an ID at random.  This ID can be read from `.id` or
`.docRef` after the document has been written.

### Read and modify a document

To access an existing document, pass its reference to the collection's
`.existingDoc()` method.  To read it, call `.load()` and access its data with
 the `.r` property; see the example below.  To make changes, use `.w` then call
`.write()`.  Reading and updating can be done in combination:

```javascript
const meats = ["pepperoni", "chicken", "sausage"];
const pizza = await pizzaCollection.existingDoc(docRef).load();
const isMeatIncluded = Object.entries(pizza.r.toppings).some(
  ([name, topping]) => topping.isIncluded && name in meats
);
if (!isMeatIncluded) {
  pizza.w.toppings.tags.push("vegetarian");
}
await pizza.write();
```

The `.r` and `.w` properties point to the same data, with the read-only accessor
typed accordingly.  Reading from `.r` is more efficient, as `.w` builds a chain
of proxies to track updates.

### Update a document in a single call

The `.update()` method is a convenience method to load and update a document.
It allows a slightly cleaner implementation of the above example --- and saves
you from forgetting to call `.write()`!

```javascript
const meats = ["pepperoni", "chicken", "sausage"];
await pizzaCollection.existingDoc(docRef).update((pizza) => {
  const isMeatIncluded = Object.entries(pizza.r.toppings).some(
    ([name, topping]) => topping.isIncluded && name in meats
  );
  if (!isMeatIncluded) {
    pizza.w.toppings.tags.push("vegetarian");
  }
});
```

### Make a copy

Finally, use `.copy()` to get a deep copy of the document.  If an ID is not
specified, it will be assigned randomly when the new doc is added to Firestore.
The copy is solely local until `.write()` is called.

```javascript
const sourceRef = doc(db, "pizza", "margherita");
const sourcePizza = await pizzaCollection.existingDoc(sourceRef).load();
const newPizza = sourcePizza.copy("meaty margh");
newPizza.name = "Meaty Margh";
newPizza.toppings.sausage = {};
newPizza.toppings.pepperoni = { included: false, surcharge: 1.25 };
newPizza.toppings.chicken = { included: false, surcharge: 1.50 };
delete newPizza.description;
delete newPizza.toppings["fresh basil"];
delete newPizza.tags.vegetarian;
newPizza.write();
```

Note the use of the `delete` operator to remove optional fields and record and
array items.

### Get all docs in a collection

You can retrieve all the documents in a collection or subcollection:

```javascript
const docs = await pizzaCollection().getAllDocs();
```

`docs` will contain an array of `FiretenderDoc` objects for all entries in the
pizzas collection.  To get the contents of a subcollection, provide the ID(s) of
its parent collection (and subcollections) to `getAllDocs()`.

### Query a collection or subcollection

To query a collection, call `query()` and pass in `where` clauses.  The
[Firestore how-to
guide](https://firebase.google.com/docs/firestore/query-data/queries) provides
many examples of simple and compound queries.

```javascript
const veggieOptions = await pizzaCollection.query(
  where("tags", "array-contains", "vegetarian")
);
const cheapClassics = await pizzaCollection.query(
  where("baseprice", "<=", 10),
  where("tags", "array-contains", "traditional")
);
```

To query a specific subcollection, provide the ID(s) of its parent collection
(and subcollections) as the first argument of `query()`.

To perform a collection group query across all instances of a particular
subcollection, leave out the IDs.  From the [Firestore how-to
example](https://firebase.google.com/docs/firestore/query-data/queries#collection-group-query),
you could retrieve all parks from all cities with this query:

```javascript
const cityLandmarkSchema = z.object({
  name: z.string(),
  type: z.string(),
});
const cityLandmarkCollection = new FiretenderCollection(
  cityLandmarkSchema,
  [firestore, "cities", "landmarks"],
  {}
);

const beijingParks = await cityLandmarkCollection.query(
  "BJ",
  where("type", "==", "park"))
);
// Resulting array contains the document for Jingshan Park.

const allParks = await cityLandmarkCollection.query(
  where("type", "==", "park")
);
// Resulting array has docs for Griffith Park, Ueno Park, and Jingshan Park.
```

### Delete a document

To delete a document from the cities example:

```javascript
const citySchema = z.object({ /* ... */ });
const cityCollection = new FiretenderCollection(
  citySchema, [firestore, "cities"], {}
);
await cityCollection.delete("LA");
```

Subcollections are not deleted; in this example, the LA landmark docs would
remain.  To also delete a document's subcollections, use `query()` to get lists
of its subcollections' docs, then call `delete()` on each doc.  The Firestore
guide recommends only performing such unbounded batched deletions from a trusted
server environment.

## TODO

The [full list of issues](https://github.com/jakes-space/firetender/issues) is
tracked on Github.  Here are some features on the roadmap:

* Dcoumentation
  * Compile JSDoc to an API reference page in markdown.
    ([#13](https://github.com/jakes-space/firetender/issues/13))
* Concurrency
  * Listen for changes and update the object if it has not been locally
    modified.  Provide an onChange() callback option.
    ([#14](https://github.com/jakes-space/firetender/issues/14))
  * Support the Firestore transaction API.
    ([#15](https://github.com/jakes-space/firetender/issues/15))
* Improved timestamp handling, tests ([multiple
  issues](https://github.com/jakes-space/firetender/issues?q=timestamp))

## Alternatives

This project is not stable yet.  If you're looking for a more mature Firestore
helper, check out:

* [Vuefire](https://github.com/vuejs/vuefire) and
  [Reactfire](https://github.com/FirebaseExtended/reactfire) for integration
  with their respective frameworks.

* [Fireschema](https://github.com/yarnaimo/fireschema): Another strongly typed
  framework for building and using schemas in Firestore.
  
* [firestore-fp](https://github.com/mobily/firestore-fp): If you like functional
  programming.

* [simplyfire](https://github.com/coturiv/simplyfire): Another
  simplified API that is focused more on querying.  (And kudos to the author for
  its great name.)

I'm sure there are many more, and apologies if I missed your favorite.
