# FirestoreProxy

FirestoreProxy is a wrapper for Firestore documents to make reading and writing
them simpler and safer.  Firestore docs look like any other Javascript object,
and they are validated upon reading and writing.

## Usage

To illustrate, let's run through the basics of defining, creating, reading, and
modifying a Firestore document.

### Define your schemas

First, define the document schemas and their validation criteria with
[Zod](https://github.com/colinhacks/zod).  If you've used Joi or Yup, you will
find Zod very similar.  Optional collections should use `.default({})` or
`.default([])` to simplify later access.

```javascript
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
```

### Add a document

Let's add a document to the `pizza-menu` collection with an ID of `margarita`.
We use FirestoreProxy.create() to create a valid local object.  We then write it
to Firestore by calling `.write()`.

```javascript
import { doc } from "firebase/firestore";
const docRef = doc(db, "pizza-menu", "margherita");
const newPizza = FirestoreProxy.create(pizzaSchema, docRef, {
  name: "Margherita",
  toppings: { "fresh mozzarella": {}, "fresh basil": {} },
  tags: ["traditional"],
});
await newPizza.write();
```

If we don't care about the doc ID, we can pass in a collection reference (e.g.,
`collection(db, "pizza-menu")`).  Firestore will assign a random ID.

### Read and modify a document

To read or write an existing document, we instantiate a FirestoreProxy with the
appropriate schema and the document's Firestore reference.  To read from it, we
call `.load()` and access the data with `.ro` (read only); to write, we modify
the `.rw` accessor and then call `.write()`.  They can be used in combination,
like so:

```javascript
const meats = ["pepperoni", "chicken", "sausage"];
const pizza = await new FirestoreProxy(pizzaSchema, docRef).load();
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
can be copied to elsewhere by specifying a document or collection reference.

```javascript
const sourceRef = doc(db, "pizza-menu", "margherita");
const sourcePizza = await new FirestoreProxy(pizzaSchema, sourceRef).load();
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

* Concurrency
  * Listen for changes and update the object if it has not been locally
    modified.  Provide an onChange() callback option.
  * Support the Firestore transaction API.
* Queries
* Document deletion
* Improved timestamp handling
