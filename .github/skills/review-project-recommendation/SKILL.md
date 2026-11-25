---
name: review-project-recommendation
description: Critically review a project planning recommendation for consistency and viability before presenting a final brief or implementation handoff.
---

# Review project recommendation

Review the draft brief against the user's goals, constraints, confirmed decisions, available evidence, and any specialist findings. This is a self-review, not an independent audit or proof that the design will work.

1. **Check consistency.** Compare the goal, scope, decisions, milestones, and acceptance criteria. Where relevant, trace a representative user flow through frontend behavior, API contracts, and data storage. Look for mismatched assumptions, incompatible contracts, missing dependencies, and conflicting specialist recommendations.
2. **Check viability.** Consider whether the proposed approach can satisfy the stated requirements within the known constraints. Examine relevant TypeScript runtime and dependency compatibility, data integrity, security, operations, testing, and delivery sequencing. Do not treat unknown cost, scale, compatibility, or feasibility as established facts.
3. **Check evidence and decisions.** Separate confirmed decisions and verified facts from recommendations and assumptions. Identify important claims without supporting evidence, unverified compatibility, and decisions the user has not made. Do not imply that research, tests, or specialist consultations occurred if they did not.
4. **Address material findings.** Correct straightforward inconsistencies without changing the user's confirmed decisions. If a specialist's recommendation is unclear, conflicts with the project goals or constraints, or conflicts with another recommendation, ask the originating specialist to clarify or revise it. Provide the specific issue, relevant context, constraints, and any conflicting findings; review the returned revision before incorporating it. For consequential cross-specialist questions, use the `specialist-communication` workflow when available. Keep follow-ups proportionate; if the specialist is unavailable or the issue remains unresolved, report it and any impact on the handoff. Ask the user about trade-offs or decisions that materially affect the recommendation. Do not hide uncertainty or make a disputed choice on the user's behalf.
5. **Report the outcome.** In the brief, summarize material findings and their resolution or remaining risks. Mark a handoff as **blocked** when an unresolved issue prevents a viable implementation decision; otherwise mark it **ready for user review**, not approved. State meaningful checks that could not be completed.

Keep the review proportional to the project. Do not invent findings, demand irrelevant specialist input, write files, execute commands, or implement the project.

## Example

If a frontend requires infinite scrolling but the proposed API only supports fetching all records, identify the mismatch and ask what pagination and data access constraints apply. A recommendation for cursor pagination remains conditional until its API and storage requirements have been checked; do not call the plan implementation-ready solely because pagination was mentioned.
