---
name: framework-data-resources
description: Find official framework, API, database, and ORM documentation. Use when a TypeScript design involves specific technologies or compares viable options.
---

# Framework and data resources

Use the resources applicable to the developer's chosen technology or a justified comparison. The examples below are not defaults or an exhaustive list. Check the project's framework, database, runtime, and versions before making compatibility claims; cite the relevant source and say when a claim cannot be verified.

## Documentation

| Task | Resources |
| --- | --- |
| Frontend framework and rendering | [React](https://react.dev/), [Next.js](https://nextjs.org/docs), [Vue](https://vuejs.org/guide/), [Angular](https://angular.dev/), [Qwik](https://qwik.dev/docs/) |
| TypeScript API frameworks | [Fastify](https://fastify.dev/docs/), [Express](https://expressjs.com/), [NestJS](https://docs.nestjs.com/), [Elysia](https://elysiajs.com/) |
| Relational database design and behavior | [PostgreSQL](https://www.postgresql.org/docs/), [MySQL](https://dev.mysql.com/doc/), [SQLite](https://www.sqlite.org/docs.html) |
| TypeScript database access and migrations | [Prisma](https://www.prisma.io/docs), [Drizzle ORM](https://orm.drizzle.team/docs/overview), [TypeORM](https://typeorm.io/docs/) |

For version-sensitive details, select the documentation matching the project's installed or proposed version. Check the database's own documentation for data integrity and query behavior instead of relying exclusively on ORM documentation.

## Optional MCP resources

[Context7](https://github.com/upstash/context7) can help retrieve framework or library documentation if its tools are configured and approved. Resolve the correct library and version before using its results; check important claims against official documentation where possible. See `general-design-resources` for other relevant MCP guidance.

This skill does not install servers or grant tools or permissions. Do not use database write tools or send private project information to external services without authorization. If a source or tool is unavailable, state the limitation rather than claiming verification.

For example, when comparing Next.js rendering options, consult the relevant version's Next.js documentation and relate the options to the project's caching and hosting constraints; do not assume the latest version or recommend Next.js merely because it appears above.
