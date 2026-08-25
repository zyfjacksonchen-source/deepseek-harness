# Agent Note: Tool registration provenance follows the visible registry winner

Status: implemented

English | [中文](2026-08-25-tool-registration-provenance.zh.md)

## Problem

A host consumer needs to identify which configured plugin registered the tool that one agent can actually see. A tool name is not an identity: a global third-party registration, a preset-scoped first-party registration, and an agent-local shadow can all use the same name. Scanning Loader entries, guessing from names, or comparing global and scoped definitions cannot distinguish the visible winner after restrictions, HMR, and teardown. Adding provenance to `ToolDefinition` would also put host composition metadata beside the model-facing schema and invite it onto prompt or session boundaries.

## Decision

`ToolRuntime.provenance(name, scope?)` returns the registration-time `{ moduleSpecifier, pluginName }` of the tool entry resolved by the registry's existing visibility view. `register()` reads only the calling Cordis fiber. When that fiber has the Loader-owned `entry`, it copies `fiber.entry.options.name` and `fiber.name` into a frozen snapshot stored beside `ToolDefinition` in the same `NamedEntries` value. A fiber without an Entry records no provenance.

The definition and provenance share one registry insert and the exact existing `ScopedLayers.effect` teardown. Restrictions, ancestor shadowing, exact-scope shadowing, HMR replacement, and disposal therefore select or remove both together. Lookup never scans Loader state, accepts caller-supplied metadata, maintains a second registry, or falls back to a hidden registration when the visible winner has no provenance. The copy is made once at registration, so later mutation or replacement of the Loader Entry cannot change an already returned identity.

The seam is host-only. `schemas()`, system-prompt assembly, tool execution, durable events, and session wire types still project only their existing allowlisted fields. Registration performs one constant-time optional Entry read and ordinary model request assembly performs no provenance discovery, preserving the normal time-to-first-token path.

## Alternatives considered

**Scan the Loader tree or infer a package from tool/plugin names.** Rejected because registration ownership is not a naming convention, and Loader state after HMR does not prove which definition won the registry view.

**Accept provenance from the registering caller or add it to `ToolDefinition`.** Rejected because a caller could claim another module and because host composition identity does not belong in the model-facing definition contract.

**Keep a second provenance map or compare global and scoped definitions.** Rejected because a second lifecycle can drift from the tool entry, and global-versus-scoped equality does not identify an ancestor or exact-scope winner.

**Expose the mutable Loader Entry or Cordis Fiber.** Rejected because it would let a read seam drift over time and expose more host capability than the two required strings.

## Consequences

Hosts can inspect the exact visible registration origin without changing model or session protocols. A scoped first-party tool wins over a same-named global third-party tool; a restriction returns `undefined`; an agent-local winner reports its own Loader-backed scope fiber or `undefined` when it has no Loader evidence; HMR and teardown remove the retired winner instead of preserving its identity. Direct programmatic registration outside Loader is deliberately unattributed. Provenance is composition evidence, not a signature, permission decision, or package-authenticity guarantee.

The contract is covered by core registry tests for global/scoped direct registration, restriction, disposal, and fiber HMR, plus the real shipped Web/base/standard composition for platform-selected `bash`/`pwsh`, `web_search`, third-party global shadowing, agent-local shadowing, Loader HMR snapshot stability, and removal. The generated Cordis/Typert catalogs keep the public type and method in sync.
