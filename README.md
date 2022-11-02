# FireTender

FireTender is a wrapper for Firestore documents to make reading and writing them
simpler and safer.  A Firestore doc looks like any other Typescript object, and
it is validated upon reading and writing.

Querying and concurrency are not yet supported.  I'm adding features as I need
them, but contributions are most welcome.  See the list of [alternative
packages](#alternatives) at the end of this README if you're looking for
something more mature.

## Usage

To illustrate, let's run through the basics of defining, creating, reading,
modifying, and copying a Firestore document.

### Define your schemas

First, we define the document schemas and their validation criteria with
[Zod](https://github.com/colinhacks/zod).  If you've used Joi or Yup, you will
find Zod very similar.  Optional collections should use `.default({})` or
`.default([])` to simplify access.  Here we define a schema for types of
pizza, because I was hungry when I wrote this.

We use the `FireTenderDoc.makeClassFactory()` convenience method to avoid having
to pass in the schema every time we instantiate a doc object.

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

const pizzaFactory = FireTenderDoc.makeClassFactoryFor(pizzaSchema);
```

### Add a document

Let's add a document to the `pizzas` collection with an ID of `margherita`.  We
use the factory's `.createNewDoc()` method to create a validated local object
representing a new document in the collection.  We then add the doc to Firestore
by calling its `.write()` method.

```javascript
const docRef = doc(db, "pizzas", "margherita");
const pizza = pizzaFactory.createNewDoc(docRef, {
  name: "Margherita",
  toppings: { "fresh mozzarella": {}, "fresh basil": {} },
  tags: ["traditional"],
});
await pizza.write();
```

If we don't care about the doc ID, we can also pass a collection reference
(e.g., `collection(db, "pizzas")`) to `.createNewDoc()`.  Firestore will assign
a random ID.

### Read and modify a document

To read or modify an existing document, we instantiate a doc wrapper using the
`.wrapExistingDoc()` factory method and passing in the doc's Firestore
reference.  To read from it, we call `.load()` and access the data with `.ro`
(read only); to write, we modify the `.rw` accessor and then call `.write()`.
They can be used in combination:

```javascript
const meats = ["pepperoni", "chicken", "sausage"];
const pizza = await pizzaFactory.wrapExistingDoc(docRef).load();
const isMeatIncluded = Object.entries(pizza.ro.toppings).some(
  ([name, topping]) => topping.isIncluded && name in meats
);
if (!isMeatIncluded) {
  pizza.rw.toppings.tags.push("vegetarian");
}
await pizza.write();
```

### Make a copy

Here we create a new pizza in the same collection.  Alternatively, a document
can be copied to elsewhere by specifying a document or collection reference
for the destination.

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
