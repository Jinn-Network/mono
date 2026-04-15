# Jinn Presentation

A Slidev presentation for the Jinn protocol, built with the Geist theme.

## Development

```bash
# Install dependencies
yarn install

# Start development server
yarn dev
```

The presentation will be available at http://localhost:3030

## Deployment

### Vercel (Recommended)

1. Connect your repository to Vercel
2. Set the root directory to `frontend/presentation`
3. Vercel will automatically detect the build settings from `vercel.json`

### Manual Static Deployment

```bash
# Build the presentation
yarn build

# The built files will be in the `dist` directory
# Upload the contents of `dist` to your static hosting provider
```

### Export to PDF/PPTX

```bash
# Export to PDF
yarn export

# Export to PPTX (requires additional setup)
yarn export --format pptx
```

## Presenter Mode

- Visit http://localhost:3030/presenter/ for presenter view with speaker notes
- Use arrow keys or click navigation to move between slides
- Press `p` to toggle presenter mode

## Features

- 13 slides covering the complete Jinn story
- Speaker notes for every slide
- Visual-first design with minimal text
- Interactive Mermaid diagrams
- Full-screen image slides for key concepts
