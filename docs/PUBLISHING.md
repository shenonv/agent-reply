# Publishing to npm (for later)

The name `agent-replay` is already taken on npm, so publish under your own scope, for example
`@your-npm-name/agent-replay`. People still run it with the `agent-replay` command. `package.json` has
`"private": true` so nothing can be published by accident.

1. In `package.json`:
   - set `"name"` to your scoped name
   - remove `"private": true`
   - add `"repository": { "type": "git", "url": "git+https://github.com/YOUR-GITHUB-NAME/agent-replay.git" }`
2. Turn on two-factor authentication for your npm account.
3. Publish, either:
   - **from GitHub (recommended):** create an npm "automation" token, save it in the GitHub repo as the secret
     `NPM_TOKEN` (Settings → Secrets and variables → Actions), then publish a GitHub release.
     `.github/workflows/publish.yml` runs the tests and publishes with provenance, which shows that the package was
     built from this repository.
   - **from your computer:** `npm publish --access public`
4. Update the README's "Run it" section to `npx @your-npm-name/agent-replay`.

Before each release, run `node --test` and `npm pack --dry-run` to see exactly which files will be published.
