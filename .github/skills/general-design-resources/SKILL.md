---
name: general-design-resources
description: Find authoritative TypeScript, web standards, security, and API design resources. Use when planning or reviewing a TypeScript application's general design.
---

# General design resources

Use the sources relevant to the question; this is a starting list, not a required checklist or an endorsement of a particular stack. Prefer project-specific versions and official documentation over summaries. Cite the page used and note relevant versions or limitations. If a source cannot be accessed, say what remains unverified.

## Documentation

| Task | Resource |
| --- | --- |
| TypeScript language, types, and configuration | [TypeScript documentation](https://www.typescriptlang.org/docs/) |
| JavaScript, HTTP, browser APIs, and accessibility | [MDN Web Docs](https://developer.mozilla.org/) |
| Web accessibility standards and guidance | [W3C Web Accessibility Initiative](https://www.w3.org/WAI/) |
| Node.js runtime APIs and behavior | [Node.js documentation](https://nodejs.org/docs/latest/api/) |
| API description formats | [OpenAPI Specification](https://spec.openapis.org/oas/) |
| HTTP and other Internet standards | [RFC Editor](https://www.rfc-editor.org/) |
| Application security risks and guidance | [OWASP](https://owasp.org/) |

Use version-specific Node.js documentation when the target version is known rather than assuming the latest release applies.

## Optional MCP resources

- [Context7](https://github.com/upstash/context7): look up library documentation when a configured, approved documentation tool is available; verify version-sensitive claims against the original source where possible.
- [GitHub MCP server](https://github.com/github/github-mcp-server): inspect public repository documentation, issues, or release notes using approved read-only tools when relevant. The server may also expose write tools; do not use them for this design workflow.

These are suggestions, not configured tools or permission grants. Check actual availability and approvals; never install or configure a server automatically. Do not send private code, credentials, or other sensitive project information to external services without authorization. If no suitable tool is available, use an approved web tool or explicitly report the limitation.

For example, when assessing browser accessibility, consult W3C or MDN for the relevant behavior and cite the source; do not treat a library's marketing page as proof of compliance.
