---
<!-- applyTo: "src/api/**/*.ts"          # Required. Glob patterns; separate multiple with commas. -->
# excludeAgent: "code-review"       # Optional: "code-review" or "cloud-agent". Leave it out so both use the file.
---

<!-- # API route rules
- Validate request input with <library> at the route boundary.
- Return errors using the `<ErrorType>` shape.
- Every route needs an integration test in `tests/api/`.
- Use consistent status codes for success and error responses.
- Document each route's expected responses.
- Keep route handlers small and focused.
- Prefer async/await for asynchronous operations.
- Handle errors consistently and in a centralized way.
- Use middleware for common tasks like authentication.
- Keep route logic separate from business logic.
- Prefer small, reusable utility functions for shared logic.
- Keep configuration separate from code.
- Never hardcode secrets in routes.
- Prefer environment variables for sensitive data.
- Avoid leaking secrets in logs.
- Use structured logging for better traceability. -->