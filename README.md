# cx-simple-exo

A minimal Next.js app demonstrating [`@contentful/experiences-react`](https://github.com/contentful/experiences)
rendering a Contentful Experience, styled by a tiny hand-rolled design system
of CSS variables.

The point of this repo is to learn the basics of fetching and rendering a
Contentful Experience, and how a simple design system can plug into
Contentful's Experience Orchestration (ExO) tooling to get an ExO project up
and running quickly. The 4 registered components are as small as possible
so that pipeline — Experience in, rendered page out — stays visible.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill in `.env.local`:

| Var | Meaning |
| --- | --- |
| `SPACE_ID` | Contentful space id |
| `ENVIRONMENT_ID` | Contentful environment id (defaults to `master`) |
| `CDA_TOKEN` | Content Delivery API access token, used for published content |
| `CPA_TOKEN` | Content Preview API access token, used when Draft Mode is on |
| `DRAFT_MODE_SECRET` | Secret required to turn on Draft Mode (pick any string) |

## Routes

- `/[locale]/[id]` — renders the Experience with id `id` in locale `locale`,
  e.g. `/en-US/homepage`. `notFound()` if the Experience doesn't exist.
- `/api/draft/enable?secret=<DRAFT_MODE_SECRET>&locale=<locale>&id=<id>` —
  turns on Draft Mode (fetches with the preview token instead of the
  delivery token) and redirects to `/<locale>/<id>`.
- `/api/draft/disable` — turns off Draft Mode and redirects back.

## Design tokens: `globals.css` → `design-tokens.ts` → components

Three pieces make up the whole design system:

1. **`app/globals.css`** — a single Tailwind v4 `@theme` block. Each entry
   (`--color-primary`, `--spacing-md`, `--text-lg`, `--radius-sm`, ...)
   becomes a real CSS custom property on `:root`. This is the only place
   actual values (colors, rem sizes) live — change a value here and every
   component that uses that token updates.

2. **`lib/design-tokens.ts`** — the bridge between Contentful and those CSS
   variables. It exports:
   - `designTokens`: a map from Contentful token id (`"color.primary"`) to
     the matching CSS variable (`"var(--color-primary)"`).
   - `resolveDesignToken`: passed to the SDK as `config.resolveToken` (see
     below) — called for every token-type design prop on an Experience node
     and turns its id into a CSS variable.
   - Small helpers components call directly for their non-token props:
     `textColor`, `textSize`, `borderRadius`, `spacing`,
     `foregroundForBackground` (picks a readable text color for a given
     background).

3. **`components/primitives/*.tsx`** (`Button`, `Text`, `Flex`, `Image`) —
   each imports only the helpers it needs from `design-tokens.ts` and
   declares its *own* curated props. No generic `style` prop, so an
   Experience can't push arbitrary CSS through a component that wasn't
   designed for it:

   ```tsx
   // Button.tsx
   import { designTokens, foregroundForBackground } from "@/lib/design-tokens";

   export function Button({ color = designTokens["color.primary"], size = "md", ... }) {
     const style = {
       backgroundColor: color,
       color: foregroundForBackground(color),
       // ...radius/spacing/fontSize from the size preset
     };
   }
   ```

If you add a new component or a new token, the flow is always the same:
add the raw value to `globals.css`, add its Contentful token id to
`designTokens` in `design-tokens.ts`, then consume it in the component via
the existing helpers (or a new one, colocated in `design-tokens.ts`).

## Fetching and rendering an Experience

- **`lib/experience-config.ts`** registers the components with the SDK and
  wires in the token resolver — the one place that ties everything above
  together:

  ```ts
  export const experienceConfig: Config = {
    components: { Button, Text, Flex, Image },
    resolveToken: resolveDesignToken,
  };
  ```

- **`app/[locale]/[id]/page.tsx`** is the whole render path for a page:
  1. `fetchExperience({ spaceId, environmentId, experienceId, locale }, { accessToken, previewToken, preview }, { config: experienceConfig, debug: preview })`
     — fetches the Experience by id/locale from Contentful (CDA, or CPA
     when Draft Mode is on), returning `null` if it doesn't exist.
  2. `<ServerExperienceRenderer experience={experience} config={experienceConfig} debug={preview} />`
     — renders it server-side using the same `experienceConfig`, resolving
     design tokens and mapping each node to its registered component.

  Both calls take the same `config`, so registering a component or a token
  once in `experience-config.ts` / `design-tokens.ts` is enough for it to
  show up correctly in both preview and published rendering.

## Header, footer, and layout

Not the main focus of this repo — included to show how an Experience can sit
inside a larger page shell, including chrome that might fetch its own data
directly from Contentful entries rather than through an Experience.
`components/chrome/SiteHeader.tsx` and `SiteFooter.tsx` are hardcoded here
(no CMS content) and built only from the same 4 primitives.
`app/[locale]/[id]/layout.tsx` reads `draftMode()` and passes it to
`SiteHeader`, which shows a banner and an "Exit draft mode" button whenever
Draft Mode is on.
