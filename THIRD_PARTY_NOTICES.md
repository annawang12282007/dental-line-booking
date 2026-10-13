# Third-party notices

The project-level [MIT License](LICENSE) covers this project's original contributions. Third-party source and packages retain their own copyright and license terms.

## Bundled source

| Material | Attribution | Included license |
| --- | --- | --- |
| `build/sites-vite-plugin.ts` | Vendored from `@openai/sites-vite-plugin` 0.2.0; Copyright (c) 2026 OpenAI | [MIT text](build/sites-vite-plugin.LICENSE) |
| `vendor/shadcn-tailwind-4.13.0.css` | shadcn; Copyright (c) 2023 shadcn | [MIT text](vendor/shadcn-tailwind-4.13.0.LICENSE.md) |

The application originated from a Sites Vinext starter. Its original setup notes are preserved in [docs/STARTER.md](docs/STARTER.md) for technical context; those notes are not a substitute for license terms.

## Package dependencies

React, Vinext, Vite, Cloudflare tooling, Drizzle, Tailwind CSS and other dependencies are declared in `package.json` and pinned in `package-lock.json`. Installed packages carry their respective license files and package metadata. These packages are not relicensed by this project's MIT notice; preserve required notices when redistributing bundled software. This document is not a claim that every transitive dependency has been independently audited.

## External services and marks

LINE Login, LIFF and the Messaging API are external services provided under their own terms. The LIFF SDK loaded by the application is subject to its upstream terms. LINE names and marks remain with their respective owners; this repository does not imply sponsorship or endorsement. Cloudflare and other product names likewise remain with their respective owners.
