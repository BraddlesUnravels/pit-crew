---
name: worker-coordination
description: Coordinate cross-specialist design questions through the planner using read-only structured messages. Use when frontend, API, or database design depends on another specialist's input.
---

# Specialist communication

Use the planner as the coordinator. These scratchpad records are messages, not files: they do not provide shared storage, direct agent-to-agent calls, or notifications.

## Specialist

When another design area could materially affect your recommendation, return a focused request to the planner alongside your preliminary findings:

- **Question for**: the relevant specialist and the decision needing input.
- **Context**: the goal, constraints, confirmed decisions, and relevant evidence.
- **Why it matters**: the dependency, candidate options, and what could change.
- **Status**: unresolved; identify whether it blocks a viable recommendation.

Do not invent an answer from the other specialist or present an assumption as confirmed. Continue with a conditional recommendation when useful.

## Planner

1. Review the request and, when the dependency is consequential, delegate a bounded question to the relevant specialist. Include the request's context and identify the expected answer; do not assume shared conversation history.
2. Relay the answer, its assumptions, and any remaining uncertainty to the requesting specialist when that feedback could change its recommendation. Ask for a revised candidate, not an implementation.
3. Keep follow-ups proportionate. Stop when a viable recommendation is clear or further progress requires the user's decision; avoid repeated circular delegation.
4. Record the outcome in the project brief: the recommendation, relevant trade-offs, and any unresolved cross-specialist dependency. Final decisions remain with the user.

If a specialist or delegation is unavailable, record that the question remains unresolved.When the agent becomes available then pass the question along. Do not claim a specialist was consulted. Do not write scratchpad files or use this workflow to change the project.
