# Releasing

Each package repository publishes from `main` with `.github/workflows/release.yml`.
A push to `main` runs the release job; an operator can also start the workflow
from Actions with `workflow_dispatch`.

The workflow reads `name` and `version` from the repository's `package.json`.
It queries `https://registry.redbtn.io` before publishing:

- If the package exists and the version is already present, publishing is
  skipped.
- If the package exists but the version is missing, that version is published.
- If the package has no registry entry, the job fails closed. Start
  `workflow_dispatch` with `allow_new_package=true` only when creating a new
  package is intentional.
- Query, publish, and tag errors fail the job; a skipped publish remains visible
  in the Actions log and still performs tag reconciliation.

After either the publish or skip path, `latest` is reconciled to the version in
`package.json`. Packages whose version contains a prerelease suffix also have
the `alpha` tag reconciled to that same version. This keeps bare installs and
explicit alpha installs aligned with `main`.

## Recovering a missed release

1. Confirm the checked-out commit is the intended `main` commit and that its
   `package.json` has the desired version.
2. Confirm authentication without publishing:

   ```sh
   npm whoami --registry https://registry.redbtn.io
   ```

3. Re-run the workflow from Actions, or on a fleet node with the repository
   checkout and its npm user config:

   ```sh
   ./scripts/release.sh
   ```

   The script is idempotent: an existing version takes the skip path, while
   missing versions are published and the tags are reconciled.
4. If the package itself is new, use the workflow dispatch input
   `allow_new_package=true`; do not use that input to bypass an unexpected
   package-name or registry configuration problem.
5. Verify the result:

   ```sh
   npm view @redbtn/<package> version --registry https://registry.redbtn.io
   npm dist-tag ls @redbtn/<package> --registry https://registry.redbtn.io
   ```

The publish credential is the repository secret `REDBTN_NPM_TOKEN`. It is
written as npm basic auth (`//registry.redbtn.io/:_auth=...`) by the workflow.
