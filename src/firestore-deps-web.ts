/**
 * Provides all dependencies normally imported from "firebase/firestore".
 *
 * For web clients, the "firebase/firestore" API is simply re-exported.
 *
 * For the server client API, ...
 */

export * from "firebase/firestore";

export const FIRESTORE_DEPS_TYPE: "web" | "admin" = "web";

export const isServerTimestamp = (data: any) =>
  data._methodName === "serverTimestamp";
