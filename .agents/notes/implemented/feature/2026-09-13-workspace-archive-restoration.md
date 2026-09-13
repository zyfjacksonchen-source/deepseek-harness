# Agent Note: Restore archived Sessions through the Workspace owner

Status: implemented

English | [中文](2026-09-13-workspace-archive-restoration.zh.md)

## Problem

The Workspace registry keeps archived Session identities and their original Workspace membership, but its public action is only `archiveSession`. A product can retain an old Session's bytes yet leave its user unable to find that Session after an upgrade. Changing the storage-domain state outside the registry would race its serialized mutations and bypass its reconnect feed.

## Decision

`WorkspaceRegistry.unarchiveSession(id)` removes exactly one identity from the durable archive set through the registry's operation chain. It leaves the Workspace's `sessionIds`, order, Session log, and attachments untouched. A known already-visible Session is an idempotent no-op; an unknown identity fails. The [Workspace Remote owner](../../../../packages/api/workspace-controller/src/index.ts) exposes the same action, returns the complete archive set, and publishes the normal `archived` follow increment. The Client Workspace model installs a Host-confirmed result only when no newer archive request or follow frame has superseded it.

The owner does not unarchive on startup. A UI must call the action in response to an explicit user gesture.

## Alternatives considered

**Edit the storage-domain JSON from a product plugin.** This bypasses the registry's serialized write and follow-stream ownership, so concurrent archive or project mutations can be lost.

**Automatically unarchive historical Sessions during migration.** This changes a user's archive choices and can expose Sessions they intentionally hid.

## Consequences

Products can offer a restore control without moving or rewriting historical Session data. The same archive projection updates active clients and reconnecting clients. The additional Remote verb is part of the pinned client/Host contract, so a product must ship matching versions on both sides. Registry and Remote tests cover selected restoration, persistence across restart, untouched project membership, unknown identities, and follow updates.
