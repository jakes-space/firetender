# Firetender

The goal of Firetender is to make Firestore documents look (almost) like any
other Typescript object, saving you some boilerplate and conceptual overhead
and providing type safety and data validation.

Querying and concurrency are not yet supported.  I'm adding features as I need
them, but contributions are most welcome.  See the list of [alternative
packages](#alternatives) at the end of this README if you're looking for
something more mature.

## Usage

To illustrate, let's run through the basics of defining, creating, modifying,
and copying a Firestore document.

### Define the schema

First, define the document schema and its validation criteria.  Firetender uses
[Zod](https://github.com/colinhacks/zod) for this; if you've used Joi or Yup,
you will find it very similar.  In the example below, I've defined a schema for
types of pizza, because I was hungry when I wrote this.

The static `FiretenderDoc.makeClassFactory()` method slightly simplifies
document creation and wrapping by capturing the schema.

```javascript
import { doc } from "firebase/firestore";
import { DocWrapper } from "firetender";
import { z } from "zod";

const pizzaSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
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
  tags: z.array(z.string()).default([]),
});

const pizzaFactory = FiretenderDoc.makeClassFactoryFor(pizzaSchema);
```

Optional records and arrays should typically Zod's `.default()` to provide an
empty collection when missing.  That isn't required, but it makes accessing
these fields less annoying.  The downside is that empty collection fields are
not pruned and will appear in Firestore.

### Add a document

Let's add a document to the `pizzas` collection, with an ID of `margherita`.  We
use the factory's `.createNewDoc()` to produce a `FiretenderDoc` representing a
new document, initialized with validated data.  This object is purely local
until it is written to Firestore by calling `.write()`.  Don't forget to do
that.

```javascript
const docRef = doc(db, "pizzas", "margherita");
const pizza = pizzaFactory.createNewDoc(docRef, {
  name: "Margherita",
  toppings: { "fresh mozzarella": {}, "fresh basil": {} },
  tags: ["traditional"],
});
await pizza.write();
```

If you don't care about the doc ID, pass a collection reference to
`.createNewDoc()` and Firestore will assign it randomly.  The resulting ID can
be read from `.id` or `.docRef`.

### Read and modify a document

To access an existing document, pass its reference to the `.wrapExistingDoc()`
factory method.  To read it, call `.load()` and access its data with the `.r`
property; see the example below.  To make changes, use `.w` then call
`.write()`.  They can be used in combination:

```javascript
const meats = ["pepperoni", "chicken", "sausage"];
const pizza = await pizzaFactory.wrapExistingDoc(docRef).load();
const isMeatIncluded = Object.entries(pizza.r.toppings).some(
  ([name, topping]) => topping.isIncluded && name in meats
);
if (!isMeatIncluded) {
  pizza.w.toppings.tags.push("vegetarian");
}
await pizza.write();
```

The `.r` and `.w` properties point to the same data, with the read-only accessor
typing it accordingly.  Reading from `.r` is more efficient, as `.w` builds a
chain of proxies to track updates.

### Make a copy

Finally, use `.copy()` to get a deep-copy of the document.  If an ID is not
specified, it will be assigned randomly by Firestore.  The copy is solely local.
After any changes are made, call `.write()` to add the new doc to Firestore.

```javascript
const sourceRef = doc(db, "pizza", "margherita");
const sourcePizza = await pizzaFactory.wrapExistingDoc(sourceRef).load();
const newPizza = sourcePizza.copy("meaty margh");
newPizza.name = "Meaty Margh";
newPizza.toppings.sausage = {};
newPizza.toppings.pepperoni = { included: false, surcharge: 1.25 };
newPizza.toppings.chicken = { included: false, surcharge: 1.50 };
delete newPizza.toppings["fresh basil"];
delete newPizza.tags.vegetarian;
newPizza.write();
```

Note the use of the `delete` operator to remove record and array items.  It also
will clear optional fields.

## TODO

* Javadoc
  * Compile them to an API reference page in markdown.
* Concurrency
  * Listen for changes and update the object if it has not been locally
    modified.  Provide an onChange() callback option.
  * Support the Firestore transaction API.
* Queries
* Document deletion
* Improved timestamp handling, tests
* Releases
  * Minify code (esbuild?)

## Alternatives

This project is not at all stable yet.  If you're looking for a more mature
Firestore helper, check out:

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
