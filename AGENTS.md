# AGENTS.md

This is a presentation-quality interactive explainer showing how open interoperability protocols for AI agents emerge layer by layer — from the inference API through tool calling, MCP, agent-to-agent coordination, and domain protocols like commerce and identity. The goal is a chunky, gamelike tech-tree interface that works for both live presentation and individual exploration, letting people understand the high-level story at a glance or click in to see real protocol messages. It succeeds when a non-technical viewer can follow the animations and get "why this standard exists," and a technical viewer can click through to see actual JSON payloads; and both can understand how each step led to the next.

## Architecture

Static SPA, no build step. `index.html` loads `style.css`, `contrib/js-yaml.min.js`, and `app.js`. `app.js` fetches and parses `data.yaml` at runtime, renders everything into `<div id="app">`.

Hash-based routing: `#` = tree view, `#<protocol-id>` = detail view. Refreshing preserves state.

## Key files

- `data.yaml` — **single source of truth** for all content: protocol metadata, tree layout positions, detail page text, and animation scene definitions. Content changes go here, not in JS.
- `app.js` — generic renderer. Reads YAML, draws tree (CSS grid + SVG connections), renders detail pages with scrollytelling animation.
- `style.css` — all styles. Brutalist aesthetic: monospace only, no border-radius, no gradients, no color, 2px solid borders, hover-invert to white-on-black.
- `STYLE_GUIDE.md` — full rationale for visual and pedagogical choices.
- `INFO_DUMP.md` — raw research notes on protocols (was `PROTOCOLS.md`).
- `tools/` — image generation scripts (Python/uv). Not part of the site.

## Conventions

- Aesthetic is 1-bit old-Mac brutalist. No border-radius. No gradients. No emoji. No color beyond grayscale. Square edges, flat, monospace.
- All text transforms to uppercase for labels/headings use `text-transform: uppercase` in CSS, not in data.
- `data.yaml` uses `>-` for paragraph strings, `|` for code/preformatted blocks, single-quoted strings for inline JSON.
- Protocol IDs are URL-safe kebab-case (e.g., `inference-api`, `agents-md`, `agent-identity`).
- Actor types in animations (`app`, `server`, `agent`, `model`, `merchant`, `registry`, `website`, `repo`, `skill`) map to consistent icon labels in `actorIconText()`.

## Testing

Serve locally: `python3 -m http.server` (or any static server). No dependencies beyond a browser. js-yaml is vendored in `contrib/`.

## Deployment

Hosted on GitHub Pages. `_config.yml` and `.nojekyll` configure static serving. Push to main to deploy.
