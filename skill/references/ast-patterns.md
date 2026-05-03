# AST Extraction Patterns

Per-language regex patterns for mechanically maintaining `code-map.md` file listings
during reconciliation. These patterns extract exported symbols **without LLM calls** —
the agent only needs to review structural changes (new entry points, removed public APIs),
not routine file-listing updates.

Patterns are intentionally simple (regex, not full AST) to keep extraction zero-dependency
and fast. False positives are acceptable — the agent corrects during judgment-call review.

## When to use

During reconciliation (step 4, mechanical updates), for each changed file in a layer's
globs, run the matching language pattern to extract top-level exports. Compare against
`code-map.md` current listings. Add/remove/rename entries mechanically.

Only flag for agent review when:
- A **new entry point** appears (structural change to the layer's public surface)
- An **exported symbol is removed** that other layers depend on (check `dependencies.outbound`)
- A **file is added** that doesn't match any existing code-map section

## Patterns by language

### TypeScript / JavaScript

```regex
^export\s+(default\s+)?(const|let|var|function|class|type|interface|enum|abstract\s+class)\s+(\w+)
^export\s+\{([^}]+)\}
^module\.exports\s*=
```

Extract: symbol name from group 3 (named exports) or group 4 (re-exports).
For `export default`, use the filename stem as the symbol name.

### Python

```regex
^(def|class)\s+(\w+)          # top-level definitions (not indented)
^__all__\s*=\s*\[([^\]]+)\]   # explicit public API
```

Extract: function/class name from group 2. If `__all__` exists, use it as the
canonical export list; otherwise use all top-level `def`/`class` that don't start
with `_`.

### Rust

```regex
^pub\s+(fn|struct|enum|trait|type|mod|const|static)\s+(\w+)
^pub\s+use\s+
```

Extract: symbol name from group 2. `pub(crate)` and `pub(super)` are internal —
include only bare `pub`.

### Go

```regex
^func\s+([A-Z]\w*)\s*\(       # exported function (capitalized)
^type\s+([A-Z]\w*)\s+          # exported type
^var\s+([A-Z]\w*)\s+           # exported var
^const\s+([A-Z]\w*)\s+         # exported const
```

Extract: symbol name from group 1. Go exports are capitalized by convention.

### Java / Kotlin

```regex
^public\s+(class|interface|enum|abstract\s+class|record)\s+(\w+)
^(fun|val|var|object)\s+(\w+)   # Kotlin top-level declarations
```

Extract: type name from group 2.

### C / C++

```regex
^(void|int|char|bool|auto|[\w:]+)\s+(\w+)\s*\(   # function definitions
^(class|struct|enum)\s+(\w+)                       # type definitions
```

Only match non-indented (column 0) definitions to avoid capturing nested symbols.

### Ruby

```regex
^(class|module)\s+(\w+)
^def\s+(\w+)                    # top-level only (not indented)
```

### Swift

```regex
^public\s+(class|struct|enum|protocol|func|var|let)\s+(\w+)
^open\s+(class)\s+(\w+)
```

### PHP

```regex
^(class|interface|trait|enum)\s+(\w+)
^function\s+(\w+)               # top-level only
```

## How results map to code-map.md

Each extracted symbol becomes a row in the layer's `code-map.md` under the appropriate
section. The mapping:

- Functions/methods → "Key functions" or "Entry points" (if exported from the layer root)
- Classes/structs/types → "Key types"
- Re-exports / barrel files → "Entry points"

The agent decides section placement during judgment review. Mechanical updates only
add/remove rows — they never change section headers or annotations.

## Limitations

- Regex extraction misses conditional exports, dynamic exports, and metaprogramming.
- It doesn't understand module resolution — a `from './foo'` import could resolve to
  `foo.ts`, `foo/index.ts`, or `foo.js`. The agent handles ambiguity during review.
- For languages not listed here, fall back to the current behavior (agent reads source).
