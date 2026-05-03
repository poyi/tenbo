# Migrate `/docs/` into tenbo

Triggered by phrases like: "migrate /docs/ into tenbo", "consolidate docs", "move docs into tenbo", "import existing docs".

This is a one-time-per-repo operation that moves engineering documentation from a flat `/docs/` folder (or similar) into the layered tenbo structure.

## Procedure

1. **List candidate doc files.** Walk `/docs/` (recursive, excluding `superpowers/` and `archive/` if present). Skip any file already migrated in a prior pass (check via `tenbo_item:` or `tenbo_layer:` frontmatter, or a `.tenbo-migrated` companion file — propose a marker convention to the user).

2. **Classify each file** into one of:
   - **A specific layer** (most common). Read the file's title and first paragraph; cross-reference with each layer's `description` and `files` globs to find the best match. If confidence is low, ask.
   - **Workspace-level cross-cutting** (deploy, local setup, glossary, anything spanning layers). Target: `.tenbo/docs/`.
   - **Scope-level cross-cutting** (rare). Target: `.tenbo/scopes/<scope>/docs/`.
   - **Superseded** (e.g., a "documentation index" file whose purpose is replaced by tenbo's structure). Propose deletion to the user.

3. **Show the proposed mapping in batches** (5–10 files per batch). Format:
   > `/docs/VARIANT_RESOLUTION_ARCHITECTURE.md` → `.tenbo/scopes/editor/layers/component-library/variant-resolution.md`

   Ask the user to confirm/correct each batch before applying.

4. **For each confirmed move:**
   - Move the file to its target path. Use `git mv` so history is preserved if the repo is git-tracked.
   - Lowercase the filename and replace underscores with dashes (`VARIANT_RESOLUTION_ARCHITECTURE.md` → `variant-resolution.md`).
   - **Update internal references.** Scan all moved files (and any remaining `/docs/` files) for relative or absolute references to the moved file. Rewrite to the new path.
   - **Update tenbo references.** If any existing layer narrative or roadmap item references the old path, update.

5. **No content rewrite.** Do not "translate" engineering docs into plain English — they're meant to stay technical. Do not run the jargon scrub on them.

6. **Validate.** Run `tenbo validate` after each batch. Surface any new issues in plain language (e.g., a moved file references a layer that doesn't exist).

7. **Final state confirmation.** Report which files moved where, which were deleted as superseded, and what (if anything) remains in `/docs/`. Suggest the user delete the empty `/docs/` directory once all content is gone, or keep it for unmigrated content like changelogs that don't fit the tenbo model.
