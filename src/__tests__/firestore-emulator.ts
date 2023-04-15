/**
 * TODO: #2 emulator setup should run before ALL test files, not before each.
 * TODO: #3 Emulator should be started before tests.
 */

import {
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { Firestore, FIRESTORE_DEPS_TYPE } from "../firestore-deps";

let testEnv: RulesTestEnvironment | undefined;

export async function setupFirestoreEmulator(port = 8080): Promise<Firestore> {
  testEnv = await initializeTestEnvironment({
    firestore: {
      host: "localhost",
      port,
      rules: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /coltests/{document=**} {
              allow read, write: if true;
            }
            match /doctests/{document=**} {
              allow read, write: if true;
            }
            match /cities/{document=**} {
              allow read, write: if true;
            }
            match /{path=**}/landmarks/{id} {
              allow read: if true;
            }
          }
        }`,
    },
    projectId: "firetender",
  });
  await testEnv.clearFirestore();
  if (FIRESTORE_DEPS_TYPE === "web") {
    return testEnv.unauthenticatedContext().firestore() as any;
  } else {
    process.env["FIRESTORE_EMULATOR_HOST"] = `localhost:${port}`;
    const app = initializeApp({ projectId: "firetender" });
    return getFirestore(app) as any;
  }
}

export async function cleanupFirestoreEmulator() {
  if (testEnv) {
    await testEnv.cleanup();
  }
}
