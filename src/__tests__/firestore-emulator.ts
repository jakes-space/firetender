import {
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { Firestore, FIRESTORE_DEPS_TYPE } from "../firestore-deps";

const EMULATOR_HOST = "127.0.0.1";
const EMULATOR_PORT = 8080;

let globalTestEnv: RulesTestEnvironment | undefined;

/**
 * Returns the Firestore test environment.
 */
async function getTestEnv(): Promise<RulesTestEnvironment> {
  if (!globalTestEnv) {
    globalTestEnv = await initializeTestEnvironment({
      firestore: { host: EMULATOR_HOST, port: EMULATOR_PORT },
      projectId: "firetender",
    });
  }
  return globalTestEnv;
}

/**
 * Clears all Firestore data in the given test environment.
 *
 * The Firestore emulator sometimes fails with response code 500 (observed for
 * Firestore 10.0.0 with CLI version 12.4.3), so we retry up to 10 times.
 */
async function clearFirestore(testEnv: RulesTestEnvironment): Promise<void> {
  for (let tryNum = 1; ; tryNum += 1) {
    try {
      await testEnv.clearFirestore();
      return;
    } catch (error: any) {
      if (error.code === "ECONNREFUSED") {
        console.error(
          `\n\nFailed to connect to the Firestore emulator at ${EMULATOR_HOST}:${EMULATOR_PORT}.\nUse "npm run start-emulator" to start it.\n`,
        );
        throw error;
      }
      if (tryNum > 10) throw error;
      console.error(error);
      console.debug(`Clearing Firestore failed (${tryNum}).  Retrying...`);
    }
  }
}

/**
 * Returns a Firestore database connected to the emulator.
 */
export async function getFirestoreEmulator(): Promise<Firestore> {
  if (FIRESTORE_DEPS_TYPE === "web") {
    const testEnv = await getTestEnv();
    return testEnv.unauthenticatedContext().firestore() as any;
  } else {
    process.env.FIRESTORE_EMULATOR_HOST = `${EMULATOR_HOST}:${EMULATOR_PORT}`;
    const app = initializeApp({ projectId: "firetender" });
    return getFirestore(app) as any;
  }
}

/**
 * Frees resources associated with the Firestore emulator.
 */
export async function cleanupFirestoreEmulator(): Promise<void> {
  if (globalTestEnv) {
    await globalTestEnv.cleanup();
  }
}

/**
 * Initializes the Firestore emulator and clear its data.
 *
 * This function is called by Jest's global setup hook.
 */
export default async function (): Promise<void> {
  const testEnv = await getTestEnv();
  await clearFirestore(testEnv);
}
