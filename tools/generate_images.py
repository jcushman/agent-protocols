#!/usr/bin/env python3
"""
Image generation harness for the Agent Protocol Tech Tree.

Loads images.yaml, resolves style placeholders, generates images via
the OpenRouter API (chat completions with image modality), and patches
data.yaml with the resulting icon paths.

Each generation call includes up to 3 previously generated images as
style references so the set stays visually consistent.

Usage:
    # Preview resolved prompts (no API call):
    uv run generate-images --dry-run

    # Generate all missing images:
    uv run generate-images

    # Regenerate a specific image:
    uv run generate-images --only icon-mcp.png

    # Also patch data.yaml with icon/actor_icon fields:
    uv run generate-images --patch-data

    # Choose a different model:
    uv run generate-images --model google/gemini-2.5-flash-image-preview

Environment:
    OPENROUTER_API_KEY   — required unless --dry-run
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import sys
from pathlib import Path

import httpx
import yaml
from rich.console import Console
from rich.table import Table

# ── Paths ──────────────────────────────────────────────────────────
TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
IMAGES_YAML = TOOLS_DIR / "images.yaml"
OUTPUT_DIR = PROJECT_ROOT / "images"
DATA_YAML = PROJECT_ROOT / "data.yaml"

# ── OpenRouter API ─────────────────────────────────────────────────
OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-3-pro-image-preview"

# How many previously-generated images to include as style references
MAX_STYLE_REFS = 3

console = Console()


# ════════════════════════════════════════════════════════════════════
#  YAML + placeholder resolution
# ════════════════════════════════════════════════════════════════════


def load_manifest() -> dict:
    """Load and return the raw images.yaml manifest."""
    with open(IMAGES_YAML) as f:
        return yaml.safe_load(f)


def resolve_placeholders(styles: dict[str, str], text: str) -> str:
    """Recursively resolve {style_name} placeholders in *text*."""
    MAX_DEPTH = 10
    for _ in range(MAX_DEPTH):
        prev = text
        for name, value in styles.items():
            text = text.replace(f"{{{name}}}", value.strip())
        if text == prev:
            break
    # Collapse whitespace runs
    text = re.sub(r"\s+", " ", text).strip()
    return text


def build_prompts(manifest: dict) -> list[dict]:
    """
    Return a list of dicts with keys:
        filename, category, prompt, (data_id | actor_type), style
    where *prompt* has all style placeholders resolved.
    """
    styles = manifest["styles"]
    results = []
    for entry in manifest["images"]:
        style_text = styles.get(entry["style"], "")
        prompt = resolve_placeholders(styles, f"{style_text} {entry['subject']}")
        rec = {
            "filename": entry["filename"],
            "category": entry["category"],
            "prompt": prompt,
        }
        if "data_id" in entry:
            rec["data_id"] = entry["data_id"]
        if "actor_type" in entry:
            rec["actor_type"] = entry["actor_type"]
        results.append(rec)
    return results


# ════════════════════════════════════════════════════════════════════
#  OpenRouter API
# ════════════════════════════════════════════════════════════════════


def _image_to_data_url(image_bytes: bytes) -> str:
    """Convert raw PNG bytes into a data-URL string."""
    b64 = base64.b64encode(image_bytes).decode()
    return f"data:image/png;base64,{b64}"


def _build_messages(
    prompt: str,
    style_refs: list[dict],
) -> list[dict]:
    """
    Build the chat messages array.

    *style_refs* is a list of {"data_url": str, "description": str} dicts
    for previously generated images to use as style anchors.
    """
    if not style_refs:
        # First image — plain text prompt
        return [{"role": "user", "content": prompt}]

    # Build multi-part content with style-reference images
    ref_descriptions = "; ".join(
        f'"{r["description"]}"' for r in style_refs
    )

    style_preamble = (
        "You are generating the next image in a sequence. "
        "Use the previous image(s) as a general style reference, but "
        "only apply visual consistency where it makes sense given the "
        "content of the new image. Do not duplicate or copy any previous "
        "image — create something entirely new that matches the "
        "description below.\n\n"
        f"Previous image(s) (for style reference only): {ref_descriptions}\n\n"
        f"New image to generate: {prompt}\n\n"
        "Guidelines:\n"
        "- Maintain consistent artistic style, color palette approach, "
        "line weight, and level of detail across the set.\n"
        "- Never duplicate elements from a previous image unless "
        "specifically mentioned in the new description.\n"
        "- The new image should be a faithful representation of its own "
        "description first, with style consistency as a secondary "
        "consideration."
    )

    parts: list[dict] = [{"type": "text", "text": style_preamble}]
    for ref in style_refs:
        parts.append(
            {
                "type": "image_url",
                "image_url": {"url": ref["data_url"]},
            }
        )

    return [{"role": "user", "content": parts}]


def generate_image(
    client: httpx.Client,
    api_key: str,
    prompt: str,
    model: str,
    style_refs: list[dict],
) -> bytes:
    """
    Call OpenRouter to generate a single image.
    Returns the raw image bytes.
    """
    messages = _build_messages(prompt, style_refs)

    resp = client.post(
        OPENROUTER_ENDPOINT,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/jcushman/agent-protocols",
            "X-Title": "Agent Protocol Tech Tree - Image Generator",
        },
        json={
            "model": model,
            "messages": messages,
            "modalities": ["image", "text"],
        },
    )

    if not resp.is_success:
        detail = resp.text[:500]
        raise RuntimeError(
            f"OpenRouter request failed ({resp.status_code}): {detail}"
        )

    data = resp.json()

    # Extract image from response
    try:
        images = data["choices"][0]["message"]["images"]
        image_url = images[0]["image_url"]["url"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(
            "No images returned in the response. "
            f"Response keys: {list(data.keys())}. "
            "Make sure the model supports image generation."
        )

    # Decode — could be a data-URL or a regular URL
    if image_url.startswith("data:image/"):
        b64_data = image_url.split(",", 1)[1]
        return base64.b64decode(b64_data)
    else:
        # Regular URL — download it
        dl = client.get(image_url, follow_redirects=True)
        dl.raise_for_status()
        return dl.content


# ════════════════════════════════════════════════════════════════════
#  data.yaml patching
# ════════════════════════════════════════════════════════════════════


def patch_data_yaml(prompts: list[dict]) -> None:
    """
    Add `icon` fields to protocols and `actor_icons` mapping to the
    top level of data.yaml so the front-end can reference images.
    """
    with open(DATA_YAML) as f:
        raw = f.read()
    data = yaml.safe_load(raw)

    # Map data_id -> relative image path for tech icons
    tech_map = {
        p["data_id"]: f"images/{p['filename']}"
        for p in prompts
        if p["category"] == "tech"
    }

    # Inject icon field into each protocol
    for proto in data.get("protocols", []):
        pid = proto["id"]
        if pid in tech_map:
            proto["icon"] = tech_map[pid]

    # Build actor_icons top-level mapping
    actor_map = {
        p["actor_type"]: f"images/{p['filename']}"
        for p in prompts
        if p["category"] == "actor"
    }
    data["actor_icons"] = actor_map

    with open(DATA_YAML, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, width=120)

    console.print(f"[green]✓[/green] Patched {DATA_YAML.relative_to(PROJECT_ROOT)}")


# ════════════════════════════════════════════════════════════════════
#  CLI
# ════════════════════════════════════════════════════════════════════


def print_table(prompts: list[dict]) -> None:
    """Pretty-print the resolved prompt table."""
    table = Table(title="Resolved Image Prompts", show_lines=True)
    table.add_column("Filename", style="cyan", no_wrap=True)
    table.add_column("Category", style="magenta", width=6)
    table.add_column("Prompt", ratio=1)
    for p in prompts:
        table.add_row(p["filename"], p["category"], p["prompt"])
    console.print(table)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate images for the Agent Protocol Tech Tree"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve and print prompts without calling the API",
    )
    parser.add_argument(
        "--only",
        metavar="FILENAME",
        help="Only generate/show this one image (by filename)",
    )
    parser.add_argument(
        "--patch-data",
        action="store_true",
        help="After generation, patch data.yaml with icon paths",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate even if the output file already exists",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"OpenRouter model to use (default: {DEFAULT_MODEL})",
    )
    args = parser.parse_args()

    manifest = load_manifest()
    all_prompts = build_prompts(manifest)

    # --only filters what we generate, but we still need the full list
    # so previously-generated images can be found as style refs.
    if args.only:
        targets = [p for p in all_prompts if p["filename"] == args.only]
        if not targets:
            console.print(f"[red]No image matching '{args.only}'[/red]")
            sys.exit(1)
    else:
        targets = all_prompts

    if args.dry_run:
        print_table(targets)
        return

    # Real generation — need API key
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        console.print(
            "[red]Error:[/red] Set OPENROUTER_API_KEY environment variable\n"
            "  Get one at https://openrouter.ai/settings/keys"
        )
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Rolling buffer of recently generated images for style consistency.
    # Each entry: {"data_url": str, "description": str, "filename": str}
    recent_refs: list[dict] = []

    # Pre-seed with any already-existing images from earlier in the
    # manifest (so --only still gets style context).
    for p in all_prompts:
        dest = OUTPUT_DIR / p["filename"]
        if dest.exists() and p not in targets:
            recent_refs.append(
                {
                    "data_url": _image_to_data_url(dest.read_bytes()),
                    "description": p["prompt"][:200],
                    "filename": p["filename"],
                }
            )
            if len(recent_refs) > MAX_STYLE_REFS:
                recent_refs.pop(0)

    with httpx.Client(timeout=120) as client:
        for i, p in enumerate(targets, 1):
            dest = OUTPUT_DIR / p["filename"]

            # Skip if already exists (unless --force)
            if dest.exists() and not args.force:
                console.print(
                    f"[dim]{i}/{len(targets)}[/dim] "
                    f"[yellow]skip[/yellow] {p['filename']} (exists, use --force)"
                )
                # Still add to refs so subsequent images get consistency
                recent_refs.append(
                    {
                        "data_url": _image_to_data_url(dest.read_bytes()),
                        "description": p["prompt"][:200],
                        "filename": p["filename"],
                    }
                )
                if len(recent_refs) > MAX_STYLE_REFS:
                    recent_refs.pop(0)
                continue

            # ── Generate via OpenRouter ────────────────────────────
            n_refs = len(recent_refs)
            ref_note = f" (+{n_refs} style ref{'s' if n_refs != 1 else ''})" if n_refs else ""
            console.print(
                f"[dim]{i}/{len(targets)}[/dim] "
                f"[bold]{p['filename']}[/bold] generating…{ref_note}"
            )

            image_bytes = generate_image(
                client,
                api_key,
                p["prompt"],
                args.model,
                recent_refs[-MAX_STYLE_REFS:],
            )

            # Save to output
            dest.write_bytes(image_bytes)

            console.print(
                f"         [green]✓[/green] saved → "
                f"{dest.relative_to(PROJECT_ROOT)}"
            )

            # Add to rolling style refs
            recent_refs.append(
                {
                    "data_url": _image_to_data_url(image_bytes),
                    "description": p["prompt"][:200],
                    "filename": p["filename"],
                }
            )
            if len(recent_refs) > MAX_STYLE_REFS:
                recent_refs.pop(0)

    if args.patch_data:
        patch_data_yaml(all_prompts)

    console.print("\n[bold green]Done.[/bold green]")


if __name__ == "__main__":
    main()
