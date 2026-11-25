---
name: elicit-missing-requirements
description: Identify information the Developer has not provided that would materially change a TypeScript project plan, and ask probing, prioritized questions to obtain it. Use at the start of planning and whenever new information reveals consequential gaps or contradictions.
---

# Elicit missing requirements

Find what the plan depends on but the Developer has not specified, then ask the questions that expose it, including uncomfortable ones. The aim is to surface consequential unknowns, contradictions, and untested assumptions before recommending anything. This is not a questionnaire to complete.

## 1. Inventory what is known

Before asking anything, review the conversation and any relevant repository context. Sort information into:

- **Stated**: what the Developer explicitly said or decided.
- **Discoverable**: what you can determine from the repository, existing configuration, or documentation. Look it up instead of asking.
- **Inferred**: what you believe but have not confirmed. Treat it as an assumption.
- **Unknown**: what is missing.

Do not ask about anything that is already stated or discoverable.

## 2. Check for gaps

Check each area and keep only the gaps relevant to this project:

- **Problem and outcome**: what problem this solves, for whom, how success is measured, and what happens if it is not built.
- **Developers and usage**: who the Developers are, how many, how often they use it, what devices and accessibility needs they have, and whether it is internal or public.
- **Scope**: what must be in the first release, explicit non-goals, and what could be cut.
- **Constraints**: deadline, budget, team size and skills, who maintains it after launch, and mandated or forbidden technologies.
- **Existing context**: greenfield or existing system, systems it must replace or integrate with, and data migration.
- **Runtime and delivery**: target runtime (browser, Node, edge, mobile, desktop), hosting or deployment target, environments, and CI.
- **Data**: what is stored, its sensitivity (PII, financial, health), volume and growth, retention and deletion, and source of truth.
- **Integrations**: third-party APIs, authentication providers, payments, email, and webhooks, plus their limits and failure modes.
- **Security and compliance**: authentication and authorization model, roles, threat exposure, and regulatory obligations (for example GDPR or the Australian Privacy Act).
- **Quality attributes**: performance targets, availability, offline needs, internationalization, and acceptable downtime or data loss.
- **Operations**: monitoring, incident ownership, backups, and cost ceilings.
- **Verification**: required testing level, acceptance process, and who signs off.

## 3. Prioritize the hard questions

Rank gaps by how much the answer would change the architecture, technology choices, scope, cost, or risk. Favor questions that:

- **Expose contradictions**, for example: "You want this live in two weeks with offline sync and multi-tenant roles. Which of those can move to a later release?"
- **Test unproven assumptions**, for example: "What evidence shows Developers need real-time updates rather than refreshing?"
- **Force trade-offs**, for example: "If cost and delivery speed conflict, which wins?"
- **Challenge the premise**, for example: "Have you considered an existing product or service instead of building this?"
- **Reveal ownership and failure**, for example: "Who is paged when this breaks, and what does an outage cost?"
- **Quantify vague terms**: when the Developer says "fast", "scalable", "secure", or "simple", ask for a number, an example, or a threshold.

Drop questions whose answers would not change the plan.

## 4. Ask in rounds

- Ask at most **5–7 questions per round**, grouped by theme and most consequential first.
- For each question, give **why it matters**: the decision it affects.
- Offer **concrete options** when that makes answering easier.
- State the **default assumption** you will use if the Developer skips the question or defers it.
- Mark questions that **block** a viable recommendation.

Use this format:

> **[Theme]**
> 1. **Question?** *Why it matters:* … *Options:* A / B / C. *If unanswered, I'll assume:* …  **(blocking)**

## 5. Record and follow up

After each round, summarize each item as **confirmed**, **assumed**, **deferred**, or **blocking**. Follow up on vague, contradictory, or partial answers. Do not re-ask questions that are settled unless new evidence conflicts with them.

Stop asking when every remaining unknown can safely become a labelled assumption, or when the Developer asks to proceed. Carry the unresolved items into the project brief's **Decisions and assumptions** and **Risks and open questions** sections.

## Boundaries

Do not invent answers, present assumptions as decisions, ask about irrelevant areas to look thorough, or interrogate Developers about decisions they have already settled. Do not write files, run commands, or implement the project.

## Example

The Developer says: "Build a booking app for my clinic." Before suggesting a stack, ask whether bookings contain health information (this affects compliance and hosting), whether staff manage availability in an existing calendar (this affects integration versus building a scheduler), the expected volume, and who maintains the app after launch. Do not ask about color schemes or animation libraries yet.