import type { TenboState, ValidateResult, ValidateIssue, Item } from '../../types';
import { VALID_PHASE_STATUSES, isIsoDate } from './phases';

const FORBIDDEN_JARGON = [
  'module', 'API', 'endpoint', 'interface', 'abstraction', 'service',
  'controller', 'DTO', 'ORM', 'repository pattern', 'middleware',
  'schema', 'polyfill', 'shim', 'AST', 'RPC', 'webhook', 'queue',
  'worker', 'daemon',
];

const VALID_STATUSES = new Set(['now', 'next', 'later', 'done', 'dropped']);
const VALID_PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);
const ITEM_ID_RE = /^[a-z]{1,5}-\d{3,}$/;
const DOC_UPDATE_REQUIRED_TYPES = new Set(['feature', 'refactor', 'bug']);
const DOC_UPDATE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_UPDATE_SKIPPED_RE = /^skipped\s*[—:-]\s*\S/;

export function validate(state: TenboState): ValidateResult {
  const errors: ValidateIssue[] = [];
  const warnings: ValidateIssue[] = [];

  // Collect every known roadmap-item id across scopes + cross-cutting roadmap.
  // Used by the relationship validator (`spawned_from`, `related`) to flag
  // references that don't resolve to anything in the workspace.
  // Also includes archived items so references to them don't produce warnings.
  const allItemIds = new Set<string>();
  for (const scope of state.scopes) {
    for (const item of scope.items) allItemIds.add(item.id);
    for (const item of scope.archivedItems ?? []) allItemIds.add(item.id);
  }
  for (const item of state.crossCuttingRoadmap ?? []) allItemIds.add(item.id);

  // Duplicate-ID detection (sk-031). Walks active + archived + cross-cutting
  // items, recording every (id → location) occurrence. An ID appearing more
  // than once anywhere in the workspace is a hard data-integrity error: it
  // breaks relationship validation, history (active vs archive), and item
  // identity. Emits one error per duplicated ID listing all locations.
  const idOccurrences = new Map<string, string[]>();
  const recordOccurrence = (id: string, where: string) => {
    if (!id || typeof id !== 'string') return;
    const arr = idOccurrences.get(id) ?? [];
    arr.push(where);
    idOccurrences.set(id, arr);
  };
  for (const scope of state.scopes) {
    for (const item of scope.items) {
      recordOccurrence(item.id, `scopes/${scope.id}/roadmap.yaml (active)`);
    }
    for (const item of scope.archivedItems ?? []) {
      recordOccurrence(item.id, `scopes/${scope.id}/roadmap-archive.yaml`);
    }
  }
  for (const item of state.crossCuttingRoadmap ?? []) {
    recordOccurrence(item.id, `.tenbo/roadmap.yaml (cross-cutting)`);
  }
  for (const [id, locs] of idOccurrences) {
    if (locs.length > 1) {
      errors.push({
        level: 'error',
        message: `duplicate item id "${id}" — appears in ${locs.join(' and ')}`,
        itemId: id,
      });
    }
  }

  const validateSupersededBy = (item: Item, scopeId?: string) => {
    if (item.superseded_by === undefined) return;
    const sb = item.superseded_by;
    if (typeof sb !== 'string' || !ITEM_ID_RE.test(sb)) {
      errors.push({ level: 'error', message: `item "${item.id}" superseded_by "${sb}" has invalid id format`, scope: scopeId, itemId: item.id });
      return;
    }
    if (sb === item.id) {
      errors.push({ level: 'error', message: `item "${item.id}" superseded_by cannot reference itself`, scope: scopeId, itemId: item.id });
      return;
    }
    if (!allItemIds.has(sb)) {
      warnings.push({ level: 'warning', message: `${item.id} superseded_by references unknown id '${sb}'`, scope: scopeId, itemId: item.id });
    }
    if (item.status !== 'dropped') {
      warnings.push({ level: 'warning', message: `${item.id} has superseded_by but status is "${item.status}" (expected "dropped")`, scope: scopeId, itemId: item.id });
    }
    // Cycle check: if the superseder also has superseded_by pointing back
    const superseder = [...state.scopes.flatMap(s => s.items), ...(state.crossCuttingRoadmap ?? [])].find(i => i.id === sb);
    if (superseder?.superseded_by === item.id) {
      errors.push({ level: 'error', message: `cycle: "${item.id}" superseded_by "${sb}" which is superseded_by "${item.id}"`, scope: scopeId, itemId: item.id });
    }
  };

  const validateRelationships = (item: Item, scopeId?: string) => {
    if (item.spawned_from !== undefined) {
      const sf = item.spawned_from;
      if (typeof sf !== 'string' || !ITEM_ID_RE.test(sf)) {
        errors.push({ level: 'error', message: `item "${item.id}" spawned_from "${sf}" has invalid id format`, scope: scopeId, itemId: item.id });
      } else if (sf === item.id) {
        errors.push({ level: 'error', message: `item "${item.id}" spawned_from cannot reference itself`, scope: scopeId, itemId: item.id });
      } else if (!allItemIds.has(sf)) {
        warnings.push({ level: 'warning', message: `${item.id} spawned_from references unknown id '${sf}'`, scope: scopeId, itemId: item.id });
      }
    }
    if (item.related !== undefined) {
      if (!Array.isArray(item.related)) {
        errors.push({ level: 'error', message: `item "${item.id}" related must be a list`, scope: scopeId, itemId: item.id });
      } else {
        const seenRel = new Set<string>();
        for (const ref of item.related) {
          if (typeof ref !== 'string' || !ITEM_ID_RE.test(ref)) {
            errors.push({ level: 'error', message: `item "${item.id}" related entry "${ref}" has invalid id format`, scope: scopeId, itemId: item.id });
            continue;
          }
          if (ref === item.id) {
            errors.push({ level: 'error', message: `item "${item.id}" related cannot reference itself`, scope: scopeId, itemId: item.id });
            continue;
          }
          if (seenRel.has(ref)) {
            warnings.push({ level: 'warning', message: `item "${item.id}" related has duplicate id '${ref}'`, scope: scopeId, itemId: item.id });
          }
          seenRel.add(ref);
          if (item.spawned_from && ref === item.spawned_from) {
            warnings.push({ level: 'warning', message: `item "${item.id}" lists '${ref}' in both spawned_from and related (redundant)`, scope: scopeId, itemId: item.id });
          }
          if (!allItemIds.has(ref)) {
            warnings.push({ level: 'warning', message: `${item.id} related references unknown id '${ref}'`, scope: scopeId, itemId: item.id });
          }
        }
      }
    }
  };

  // Spec-link lifecycle validation (Phase 6 of x-001).
  // Specs migrated from `roadmap/<id>-slug.md` to `.tenbo/specs/<id>-slug.md`,
  // and archive when the item flips to `done`. These warnings flag drift
  // between item status and spec location, plus links pointing at the old
  // roadmap/ path. All warnings (not errors) so cleanup can land incrementally.
  const validateSpecLinks = (item: Item, scopeId?: string) => {
    const links = item.links ?? [];
    for (const link of links) {
      if (typeof link !== 'string') continue;
      // Old roadmap/ path detection.
      if (/^roadmap\/[a-z]{1,5}-\d{3,}-.*\.md$/i.test(link)) {
        warnings.push({
          level: 'warning',
          message: `${item.id} links to old spec path; should be .tenbo/specs/${link.slice('roadmap/'.length)}`,
          scope: scopeId,
          itemId: item.id,
        });
        continue;
      }
      const inSpecs = link.startsWith('.tenbo/specs/');
      if (!inSpecs) continue;
      const inArchive = link.startsWith('.tenbo/specs/archive/');
      // File-existence check (only when state.specFiles is populated).
      if (state.specFiles && !state.specFiles.has(link)) {
        warnings.push({
          level: 'warning',
          message: `${item.id} links to ${link} which does not exist`,
          scope: scopeId,
          itemId: item.id,
        });
      }
      // Lifecycle: status vs archive.
      if (item.status === 'done' && !inArchive) {
        warnings.push({
          level: 'warning',
          message: `${item.id} is done but its spec hasn't been archived`,
          scope: scopeId,
          itemId: item.id,
        });
      } else if (item.status && item.status !== 'done' && inArchive) {
        warnings.push({
          level: 'warning',
          message: `${item.id} is ${item.status} but its spec is archived`,
          scope: scopeId,
          itemId: item.id,
        });
      }
    }
  };

  for (const scope of state.scopes) {
    const layerIds = new Set(scope.layers.map(l => l.id));

    // Layer rules
    for (const layer of scope.layers) {
      if (!layer.id || !layer.name || !layer.description || !layer.files?.length) {
        errors.push({ level: 'error', message: `layer "${layer.id}" is missing required fields`, scope: scope.id, layerId: layer.id });
      }
      if (layer.parent && !layerIds.has(layer.parent)) {
        errors.push({ level: 'error', message: `layer "${layer.id}" parent "${layer.parent}" does not exist`, scope: scope.id, layerId: layer.id });
      }
      if (!state.narratives[`${scope.id}/${layer.id}`]) {
        errors.push({ level: 'error', message: `layer "${layer.id}" is missing its narrative file`, scope: scope.id, layerId: layer.id });
      }
      const wc = (layer.description ?? '').trim().split(/\s+/).length;
      if (wc < 5 || wc > 30) {
        warnings.push({ level: 'warning', message: `layer "${layer.id}" description is ${wc < 5 ? 'too short' : 'too long'} (${wc} words)`, scope: scope.id, layerId: layer.id });
      }
      for (const word of FORBIDDEN_JARGON) {
        const re = new RegExp(`\\b${word}\\b`, 'i');
        if (re.test(layer.description ?? '')) {
          warnings.push({ level: 'warning', message: `layer "${layer.id}" description uses "${word}"`, scope: scope.id, layerId: layer.id });
        }
      }
      // v2: intent.md empty check
      const docs = state.layerDocs?.[`${scope.id}/${layer.id}`];
      if (docs?.hasIntent && docs.intentEmpty) {
        errors.push({ level: 'error', message: `layer "${layer.id}" intent.md is empty`, scope: scope.id, layerId: layer.id });
      }
      // v2: dependencies resolution
      const outbound = layer.dependencies?.outbound ?? [];
      for (const dep of outbound) {
        if (!layerIds.has(dep)) {
          errors.push({ level: 'error', message: `layer "${layer.id}" dependencies.outbound references "${dep}" which does not exist`, scope: scope.id, layerId: layer.id });
        }
      }
      const inbound = layer.dependencies?.inbound ?? [];
      for (const dep of inbound) {
        if (!layerIds.has(dep)) {
          errors.push({ level: 'error', message: `layer "${layer.id}" dependencies.inbound references "${dep}" which does not exist`, scope: scope.id, layerId: layer.id });
        }
      }
      if (state.layerDocs && !state.layerDocs[`${scope.id}/${layer.id}`]?.hasCodeMap) {
        warnings.push({ level: 'warning', message: `layer "${layer.id}" has no code-map.md`, scope: scope.id, layerId: layer.id });
      }
    }

    // Item rules. Note: cross-scope/active+archive duplicate-id detection runs
    // once at the top of validate() (sk-031) — no per-scope seenIds needed.
    for (const item of scope.items) {
      if (!/^[a-z]{1,5}-\d{3,}$/.test(item.id)) {
        errors.push({ level: 'error', message: `item "${item.id}" has invalid id format (expected <prefix>-NNN, e.g. ed-001 or x-001)`, scope: scope.id, itemId: item.id });
      }
      // Status is optional when phases are present (it's derived via roll-up).
      // Only validate when explicitly set.
      const hasPhases = Array.isArray(item.phases) && item.phases.length > 0;
      if (item.status !== undefined && item.status !== null) {
        if (!VALID_STATUSES.has(item.status)) {
          errors.push({ level: 'error', message: `item "${item.id}" has invalid status "${item.status}"`, scope: scope.id, itemId: item.id });
        }
      } else if (!hasPhases) {
        errors.push({ level: 'error', message: `item "${item.id}" is missing required status (or phases)`, scope: scope.id, itemId: item.id });
      }
      if (item.priority !== undefined && !VALID_PRIORITIES.has(item.priority)) {
        errors.push({ level: 'error', message: `item "${item.id}" has invalid priority "${item.priority}" (expected p0, p1, p2, or p3)`, scope: scope.id, itemId: item.id });
      }
      if (item.layer && !layerIds.has(item.layer)) {
        errors.push({ level: 'error', message: `item "${item.id}" references layer "${item.layer}" which does not exist`, scope: scope.id, itemId: item.id });
      }
      if (item.layers?.length) {
        for (const ref of item.layers) {
          const [sId, lId] = ref.split('.');
          const targetScope = state.scopes.find(s => s.id === sId);
          if (!targetScope || !targetScope.layers.some(l => l.id === lId)) {
            errors.push({ level: 'error', message: `cross-scope ref "${ref}" on item "${item.id}" doesn't resolve`, itemId: item.id });
          }
        }
      }
      if (item.status === 'now' && !item.done_when?.length) {
        warnings.push({ level: 'warning', message: `item "${item.id}" has status:now but no done_when criteria`, scope: scope.id, itemId: item.id });
      }
      for (const word of FORBIDDEN_JARGON) {
        const re = new RegExp(`\\b${word}\\b`, 'i');
        if (re.test(item.description ?? '')) {
          warnings.push({ level: 'warning', message: `item "${item.id}" description uses "${word}"`, scope: scope.id, itemId: item.id });
        }
      }

      // Relationship validation (Phase 5 of x-001).
      validateRelationships(item, scope.id);

      // Superseded-by validation (sk-015).
      validateSupersededBy(item, scope.id);

      // Spec-link lifecycle validation (Phase 6 of x-001).
      validateSpecLinks(item, scope.id);

      // Doc-update gate (Phase 3 of x-003). Warn on done items whose type
      // implies architecture surface impact but doc_update is missing or
      // malformed. Items without `type:` are exempt — the gate only fires
      // when the item explicitly opted in to a typed shape (via Behavior 13
      // audit, or hand-set). This keeps existing un-typed done items quiet
      // while catching every new shipped feature/refactor/bug going forward.
      if (item.status === 'done' && item.type && DOC_UPDATE_REQUIRED_TYPES.has(item.type)) {
        const du = item.doc_update;
        if (du === undefined || du === null || (typeof du === 'string' && du.trim() === '')) {
          warnings.push({
            level: 'warning',
            message: `${item.id} is done (type=${item.type}) but doc_update is not stamped — confirm the layer's intent.md/code-map.md was updated, then set doc_update: <YYYY-MM-DD> or doc_update: skipped — <reason>`,
            scope: scope.id,
            itemId: item.id,
          });
        } else if (typeof du !== 'string') {
          errors.push({
            level: 'error',
            message: `${item.id} doc_update must be a string (got ${typeof du})`,
            scope: scope.id,
            itemId: item.id,
          });
        } else if (!DOC_UPDATE_DATE_RE.test(du.trim()) && !DOC_UPDATE_SKIPPED_RE.test(du.trim())) {
          warnings.push({
            level: 'warning',
            message: `${item.id} doc_update "${du}" is malformed — expected YYYY-MM-DD or 'skipped — <reason>'`,
            scope: scope.id,
            itemId: item.id,
          });
        }
      }

      // Goal-ref shape validation (sk-025). Optional field; warn (do not error)
      // when missing or malformed. Shape-check only — does NOT cross-reference
      // against `overview.md` Product goals (deferred per sk-022 risks).
      // Skip the missing-warning for done/dropped items: no value in nagging
      // about completed work.
      if (item.goal_ref === undefined) {
        if (item.status !== 'done' && item.status !== 'dropped') {
          warnings.push({
            level: 'warning',
            message: `item ${item.id} has no goal_ref — backfill with cited goals or "exploratory"`,
            scope: scope.id,
            itemId: item.id,
          });
        }
      } else if (item.goal_ref === 'exploratory') {
        // Valid literal — no warning.
      } else if (Array.isArray(item.goal_ref)) {
        if (item.goal_ref.length === 0) {
          warnings.push({
            level: 'warning',
            message: `item ${item.id}.goal_ref is an empty array — use "exploratory" if no goals identified, or remove the field`,
            scope: scope.id,
            itemId: item.id,
          });
        } else {
          for (const ref of item.goal_ref) {
            if (typeof ref !== 'string') {
              warnings.push({
                level: 'warning',
                message: `item ${item.id}.goal_ref must be a string array or the literal "exploratory" — got: ${typeof ref} entry`,
                scope: scope.id,
                itemId: item.id,
              });
              break;
            }
          }
        }
      } else {
        warnings.push({
          level: 'warning',
          message: `item ${item.id}.goal_ref must be a string array or the literal "exploratory" — got: ${typeof item.goal_ref}`,
          scope: scope.id,
          itemId: item.id,
        });
      }

      // Pre-flight violations (sk-029). Optional field; surface as a health
      // observation (warning) when an item carries any accept-with-violation
      // entry. Skip done/dropped items — no value nagging completed work.
      // Shape-check only: validate array shape and enum values; don't
      // cross-validate `check` strings against any taxonomy.
      if (item.preflight_violations !== undefined) {
        if (!Array.isArray(item.preflight_violations)) {
          errors.push({ level: 'error', message: `item "${item.id}" preflight_violations must be a list`, scope: scope.id, itemId: item.id });
        } else {
          const VALID_OUTCOMES = new Set(['violation', 'threshold-cross', 'dependency-direction']);
          const VALID_DECISIONS = new Set(['accept-with-violation', 'scope-adjusted', 'deferred']);
          let acceptedCount = 0;
          for (const entry of item.preflight_violations) {
            if (!entry || typeof entry !== 'object') {
              errors.push({ level: 'error', message: `item "${item.id}" preflight_violations entry is not an object`, scope: scope.id, itemId: item.id });
              continue;
            }
            if (typeof (entry as any).check !== 'string' || (entry as any).check.trim() === '') {
              errors.push({ level: 'error', message: `item "${item.id}" preflight_violations entry missing string "check"`, scope: scope.id, itemId: item.id });
            }
            if (!VALID_OUTCOMES.has((entry as any).outcome)) {
              errors.push({ level: 'error', message: `item "${item.id}" preflight_violations entry has invalid outcome "${(entry as any).outcome}"`, scope: scope.id, itemId: item.id });
            }
            if (!VALID_DECISIONS.has((entry as any).decision)) {
              errors.push({ level: 'error', message: `item "${item.id}" preflight_violations entry has invalid decision "${(entry as any).decision}"`, scope: scope.id, itemId: item.id });
            }
            if ((entry as any).decision === 'accept-with-violation') acceptedCount++;
          }
          if (acceptedCount > 0 && item.status !== 'done' && item.status !== 'dropped') {
            warnings.push({
              level: 'warning',
              message: `item ${item.id} has accepted ${acceptedCount} pre-flight violation(s) — review at next audit`,
              scope: scope.id,
              itemId: item.id,
            });
          }
        }
      }

      // Phase schema validation (Phase 3 of x-001).
      if (item.phases !== undefined) {
        if (!Array.isArray(item.phases)) {
          errors.push({ level: 'error', message: `item "${item.id}" phases must be a list`, scope: scope.id, itemId: item.id });
        } else {
          // If both `status:` and `phases:` are present, item.status will be derived;
          // emit a warning so authors drop the explicit status.
          if (item.phases.length > 0 && item.status !== undefined && item.status !== null) {
            warnings.push({ level: 'warning', message: `item "${item.id}" has both status and phases — status will be derived from phases, drop the explicit status`, scope: scope.id, itemId: item.id });
          }
          const seenPhaseIds = new Set<number>();
          item.phases.forEach((ph, idx) => {
            const expectedId = idx + 1;
            if (typeof ph.id !== 'number' || !Number.isInteger(ph.id)) {
              errors.push({ level: 'error', message: `item "${item.id}" phase at position ${expectedId} is missing an integer id`, scope: scope.id, itemId: item.id });
            } else {
              if (ph.id !== expectedId) {
                errors.push({ level: 'error', message: `item "${item.id}" phase at position ${expectedId} has id ${ph.id} (ids must be 1..N matching position)`, scope: scope.id, itemId: item.id });
              }
              if (seenPhaseIds.has(ph.id)) {
                errors.push({ level: 'error', message: `item "${item.id}" has duplicate phase id ${ph.id}`, scope: scope.id, itemId: item.id });
              }
              seenPhaseIds.add(ph.id);
            }
            if (!ph.title || typeof ph.title !== 'string') {
              errors.push({ level: 'error', message: `item "${item.id}" phase ${ph.id ?? expectedId} is missing a title`, scope: scope.id, itemId: item.id });
            }
            if (!ph.status || !VALID_PHASE_STATUSES.has(ph.status)) {
              errors.push({ level: 'error', message: `item "${item.id}" phase ${ph.id ?? expectedId} has invalid status "${ph.status}"`, scope: scope.id, itemId: item.id });
            }
            if (ph.completed_at !== undefined) {
              if (typeof ph.completed_at !== 'string' || !isIsoDate(ph.completed_at)) {
                errors.push({ level: 'error', message: `item "${item.id}" phase ${ph.id ?? expectedId} completed_at "${ph.completed_at}" is not YYYY-MM-DD`, scope: scope.id, itemId: item.id });
              }
            }
            if (ph.status === 'done' && !ph.completed_at) {
              warnings.push({ level: 'warning', message: `item "${item.id}" phase ${ph.id ?? expectedId} is done but has no completed_at`, scope: scope.id, itemId: item.id });
            }
            if (ph.status !== 'done' && ph.completed_at) {
              warnings.push({ level: 'warning', message: `item "${item.id}" phase ${ph.id ?? expectedId} has completed_at but status is "${ph.status}"`, scope: scope.id, itemId: item.id });
            }
          });
        }
      }
    }
  }

  // Decision records (sk-020). Validate frontmatter shape on every file under
  // `.tenbo/decisions/`. Additive: state.decisions is undefined when the
  // directory does not exist, so existing repos without decisions/ stay quiet.
  if (state.decisions) {
    const VALID_DECISION_STATUSES = new Set(['accepted', 'superseded']);
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const decisions = state.decisions;
    for (const slug of Object.keys(decisions)) {
      const rec = decisions[slug];
      const fm = rec.frontmatter ?? {};
      const where = rec.path;
      // Required fields → errors.
      for (const field of ['id', 'date', 'status', 'title'] as const) {
        const v = fm[field];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
          errors.push({ level: 'error', message: `decision ${where} is missing required frontmatter field "${field}"` });
        }
      }
      if (typeof fm.status === 'string' && !VALID_DECISION_STATUSES.has(fm.status)) {
        errors.push({ level: 'error', message: `decision ${where} has invalid status "${fm.status}" (expected accepted|superseded)` });
      }
      if (fm.date !== undefined && typeof fm.date === 'string' && fm.date.trim() !== '' && !ISO_DATE_RE.test(fm.date.trim())) {
        warnings.push({ level: 'warning', message: `decision ${where} date "${fm.date}" is not YYYY-MM-DD` });
      }
      if (fm.status === 'superseded') {
        const sb = fm.superseded_by;
        if (typeof sb !== 'string' || sb.trim() === '') {
          errors.push({ level: 'error', message: `decision ${where} has status:superseded but no superseded_by` });
        } else if (!state.decisions[sb]) {
          errors.push({ level: 'error', message: `decision ${where} superseded_by "${sb}" does not match a sibling decision file` });
        } else if (sb === slug) {
          errors.push({ level: 'error', message: `decision ${where} superseded_by cannot reference itself` });
        }
      } else if (fm.superseded_by !== undefined && fm.status !== 'superseded') {
        warnings.push({ level: 'warning', message: `decision ${where} has superseded_by but status is "${fm.status ?? 'unset'}"` });
      }
      if (fm.related_items !== undefined && !Array.isArray(fm.related_items)) {
        warnings.push({ level: 'warning', message: `decision ${where} related_items should be a list` });
      }
    }
  }

  const allRefs = new Set(state.scopes.flatMap(s => s.layers.map(l => `${s.id}:${l.id}`)));
  for (const item of state.crossCuttingRoadmap ?? []) {
    const refs = [...(item.layers ?? []), ...(item.affects ?? [])];
    for (const ref of refs) {
      if (!allRefs.has(ref)) {
        errors.push({ level: 'error', message: `cross-cutting item "${item.id}" references "${ref}" which does not resolve`, itemId: item.id });
      }
    }
    validateRelationships(item);
    validateSupersededBy(item);
    validateSpecLinks(item);
  }

  return { errors, warnings };
}
