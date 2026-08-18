# Agent Note: Redundant sandbox targets

Status: implemented

English | [中文](2026-08-18-redundant-sandbox-targets.zh.md)

## Problem

Model calls can repeat the current `sandbox_permissions` value or request a narrower target. Routing every supplied target through the widening validator rejects these calls even though the standing policy already authorizes the command. Treating a narrower target as an execution downgrade would also be false because the executor does not promise per-call confinement below the standing policy.

## Decision

The Bash and PowerShell tools classify a requested target against the standing policy before approval. A target equal to the standing mode, or any target requested while the standing mode is `danger-full-access`, is redundant: the command runs under the unchanged standing policy and prompts no one. Only a strictly wider valid target enters the existing approval path. Missing sandbox composition, malformed modes, unavailable approval, rejection, and cancellation remain fail-closed errors.

This refines the escalation behavior owned by [the sandbox decision](../feature/2026-07-06-sandbox.md). It adds no grant, persistent state, tool, executor, or per-call downgrade path.

## Alternatives considered

- **Reject every non-widening target.** Rejected because a redundant model field must not block a command already authorized by the standing policy.
- **Execute a narrower requested mode for that call.** Rejected because the current executor contract does not provide a per-call downgrade and reporting one would overstate confinement.
- **Hide escalation fields from sessions already at the widest mode.** Rejected because tool schemas are registry-global while the effective sandbox mode is per-session.

## Consequences

Redundant `sandbox_permissions` arguments no longer produce a tool error or approval prompt, and they never reduce or expand the command's standing authority. Bash and PowerShell tests cover equal and narrower targets at `workspace-write` and `danger-full-access` while retaining the invalid-composition, malformed-mode, true-widening, rejection, cancellation, and unavailable-approval cases.
