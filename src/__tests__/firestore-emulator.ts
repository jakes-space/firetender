/**
 * TODO: This emulator setup should run before ALL test files, not before each.
 * TODO: Emulator should be started before tests, if it is not already running.
 */

import {
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection } from "firebase/firestore";

let testEnv: RulesTestEnvironment;

export async function setupFirestoreEmulator(port = 8080) {
  testEnv = await initializeTestEnvironment({
    firestore: {
      host: "localhost",
      port,
      rules: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents/coltests/{testid} {
            allow read, write: if true;
          }
          match /databases/{database}/documents/doctests/{testid} {
            allow read, write: if true;
          }
        }
        `,
    },
    projectId: "firetender",
  });
  // Creating a dummy collection is needed because the Firestore object returned
  // by testenv.unauthenticatedContext().firestore() is missing some properties.
  // Getting it from a collection fixes that, probably due to some type coersion
  // going on inside of collection().  It's ugly, but it works.
  return collection(testEnv.unauthenticatedContext().firestore(), "dummy")
    .firestore;
}

export async function cleanupFirestoreEmulator() {
  if (testEnv) {
    await testEnv.cleanup();
  }
}
