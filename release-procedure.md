# Release procedure

Because of the hacky way this package provides both the
[`firetender`](https://www.npmjs.com/package/firetender) and
[`firetender-admin`](https://www.npmjs.com/package/firetender-admin) npms, we
cannot simply use `npm version` followed by `npm publish`.  Instead:

1. Optionally update dependencies: `npm run update-deps`.
1. Run `npm run check` and fix any issues.
1. Switch to admin mode and run the tests:  
   `npm run use-admin-firestore && npm run test && npm run use-web-firestore`
1. Manually set the new version number in `package.json`, `package-web.json`,
   and `package-admin.json`.
1. Run `npm i`.
1. Commit the change.  The name of the commit should be the new version number
   and nothing else (e.g., `0.10.4`).  Versioning series start at zero (e.g., a
   minor version upgrade of `0.10.4` is `0.11.0`).
1. Run `npm run use-admin-firestore && npm publish`.
1. Run `npm run use-web-firestore && npm publish`.
