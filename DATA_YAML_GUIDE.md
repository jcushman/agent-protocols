# data.yaml Guide

Compact reference for editing the tech tree data file.

---

## Top-Level Structure

```yaml
title: string          # Site title
subtitle: string       # Site subtitle
actor_icons: {type: path}  # Image paths for animation actors
clusters: [...]        # Visual groupings in the tree
technologies: [...]    # Protocol/technology nodes
```

---

## Technologies

Each entry in `technologies` represents a node in the tree.

```yaml
- id: kebab-case-id         # URL-safe, used in hash routing (#inference-api)
  title: Display Name
  icon: images/icon-*.png   # Node icon path
  icon_alt: ">_"            # Short text fallback for icon
  tagline: One-line summary
  layout: {...}             # Tree positioning (see below)
  unlock: {...}             # Optional lock state
  detail: {...}             # Detail page content
  animation: {...}          # Optional scrollytelling scenes
```

### Layout

Controls tree positioning. Uses parent-relative or explicit positioning:

```yaml
layout: {}                              # Root node (no parent)
layout: { parent: inference-api }       # Below parent, same column
layout: { parent: tool-calling, offset: 2 }  # 2 columns right of parent
layout: { col: 3, parent: tool-calling }     # Explicit column
layout: { parents: [a, b, c, d] }       # Multiple parents (fan-in)
```

### Unlock (Optional)

```yaml
unlock: { state: locked, class: foundational }  # Stone icon overlay
unlock: { state: locked, class: frontier }      # Rocket icon overlay
```
Omit for unlocked nodes.

### Detail

Required fields for the detail page:

```yaml
detail:
  links:                     # Spec/launch links
    - { label: "Standard", url: "https://..." }
    - { label: "Launch", url: "https://..." }
  what_it_solves: >-         # Problem statement (plain language)
    Why this protocol exists...
  how_its_standardizing: >-  # Standardization status
    How consensus emerged or is emerging...
  virtuous_cycle:            # 3 bullets showing the feedback loop
    - "First actor benefit..."
    - "Second actor benefit..."
    - "Third actor benefit..."
```

---

## Animation

Optional. Defines the scrollytelling "How it works" section.

```yaml
animation:
  actors:
    - id: app              # Unique within this protocol
      label: Your App      # Display name
      type: app            # Actor type (maps to icon)
  scenes:
    - title: Scene Title
      description: >-
        What's happening in this scene...
      actors_visible: [app, server]  # Which actors appear (left-to-right)
      sparkle: true                  # Optional: show "INTEROPERABLE" badge
      messages:
        - from: app
          to: server
          label: Request label       # Arrow text (uppercased in display)
          json_preview: '{"short": "..."}'  # One-line preview
          json_full: |               # Optional: expandable full payload
            {
              "detailed": "...",
              "multiline": true
            }
```

### Actor Types

Used in `type` field, maps to icons defined in `actor_icons`:

| Type       | Typical Use                    |
|------------|--------------------------------|
| `app`      | Client application             |
| `model`    | LLM/AI model                   |
| `server`   | API server/service             |
| `agent`    | AI agent                       |
| `repo`     | Code repository                |
| `website`  | Documentation site             |
| `registry` | Key/capability registry        |
| `merchant` | Commerce endpoint              |
| `skill`    | Agent skill package            |

### Scene Pattern

Follow this arc for pedagogical clarity:

1. **Basic flow** — Show the protocol working between two actors
2. **Swap scene** — Replace one actor with a different implementation; same protocol still works. Mark with `sparkle: true`

---

## Clusters

Visual dashed-outline groups in the tree view:

```yaml
clusters:
  - id: c-foundations
    label: Model building standards
    members: [tokenizers, weight-formats, embeddings, chat-templates]
```

---

## YAML Conventions

| Pattern | Use For |
|---------|---------|
| `>-` | Paragraph text (folded, no trailing newline) |
| `\|` | Code blocks / preformatted (literal, preserves newlines) |
| Single quotes | Inline JSON: `'{"key": "value"}'` |
| Kebab-case | IDs: `agent-identity`, `tool-calling` |

---

## Quick Checklist: Adding a Protocol

1. Add entry to `technologies` with unique `id`
2. Set `layout` relative to parent node
3. Write `detail` fields: `links`, `what_it_solves`, `how_its_standardizing`, `virtuous_cycle`
4. Create `animation` with 2-4 scenes (basic flow → sparkle swap)
5. Add to a `cluster` if it belongs to a group
6. Generate icon: `cd tools && uv run generate-images`
