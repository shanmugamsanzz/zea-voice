# Database migrations

Versioned PostgreSQL migrations live in the `migrations` directory. Create a
migration with:

```powershell
npm run db:create-migration -- descriptive-name
```

Pending migrations are applied automatically when the API starts and
`AUTO_MIGRATE=true`. The initial migration creates the multi-tenant core schema,
forced row-level security policies, and a restricted database runtime role.
