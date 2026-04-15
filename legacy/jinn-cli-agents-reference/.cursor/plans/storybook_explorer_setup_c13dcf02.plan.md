---
name: Storybook Explorer Setup
overview: Add Storybook 8 to the frontend/explorer Next.js project with proper Tailwind v4 and path alias configuration.
todos:
  - id: update-components-json
    content: Add @storybook registry to components.json
    status: pending
  - id: install-deps
    content: Add Storybook devDependencies to package.json
    status: pending
  - id: create-main-config
    content: Create .storybook/main.ts with Next.js framework
    status: pending
  - id: create-preview-config
    content: Create .storybook/preview.ts with globals.css import
    status: pending
  - id: add-scripts
    content: Add storybook scripts to package.json
    status: pending
  - id: install-stories
    content: Install stories from @storybook registry for existing components
    status: pending
---

# Storybook Setup for frontend/explorer

## Approach

Use the **Shadcn Storybook Registry** (`@storybook`) which provides pre-built stories for all shadcn/ui components, installable via the shadcn CLI.

## Step 1: Add Registry to components.json

Add the `@storybook` registry to `frontend/explorer/components.json`:

```json
{
  "registries": {
    "@storybook": "https://registry.lloydrichards.dev/v2/r/{name}.json"
  }
}
```

## Step 2: Install Storybook Dependencies

```bash
cd frontend/explorer
yarn add -D @storybook/nextjs @storybook/addon-essentials @storybook/blocks @storybook/react storybook
```

## Step 3: Create Storybook Config

**`.storybook/main.ts`**:

- Framework: `@storybook/nextjs`
- Stories glob: `../src/**/*.stories.@(ts|tsx)`
- Path alias: `@/*` -> `path.resolve(__dirname, "../src/*")`

**`.storybook/preview.ts`**:

- Import `../src/app/globals.css`

## Step 4: Add Scripts to package.json

```json
"storybook": "storybook dev -p 6006",
"build-storybook": "storybook build"
```

## Step 5: Install Stories from Registry

Use shadcn CLI to pull stories for components already in use:

```bash
npx shadcn@latest add @storybook/button-story
npx shadcn@latest add @storybook/card-story
# etc. for each ui component
```

This places `.stories.tsx` files alongside the components (or in a designated folder based on your aliases).