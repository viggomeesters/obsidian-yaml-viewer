# Contributing

Thanks for considering a contribution.

## Development setup

```bash
npm install
npm run build
npx tsc --noEmit
```

For manual testing, copy or symlink this repository into an Obsidian vault:

```text
.obsidian/plugins/yaml-viewer/
```

Reload Obsidian and enable **YAML Viewer** in **Settings -> Community plugins**.

## Design constraints

- Keep the plugin read-only.
- Do not write YAML back to disk.
- Avoid editor-level dependencies unless they are clearly needed.
- Prefer Obsidian-native DOM APIs and small, focused changes.
- Preserve comments and surface parser errors clearly.

## Pull requests

Please include:

- what changed
- why it changed
- screenshots for visible UI changes
- validation output for `npm run build` and `npx tsc --noEmit`
