# Continuous conversation threads

Task 5 links every new persisted phone call to one conversation per company and normalized E.164 contact number. Inbound calls use the caller number; outbound calls use the recipient number. The same contact can call different agents or workspaces in their company and remain in the same thread. Different companies remain isolated. Browser tests do not create phone contact history.

Migration `1791372000000_continuous-conversation-linking.js` runs an insert trigger covering inbound, campaign, phone-test and shared-link calls. It requires the Task 1 storage migration. Company/number and company/contact uniqueness prevent duplicate contacts and threads. Linking is idempotent; existing caller names are preserved. The trigger runs in the call transaction under existing row-level security: a linking failure rolls back the call insertion rather than silently losing history.

The thread stores links to calls. Each call retains its original transcript entries, recording, status/result, summary and billing records. Failed and missed calls are linked too; the existing dynamic context still distinguishes answered history. Call identity (company, direction and endpoint numbers) must remain fixed after insertion. The conversation screen is a later task.

Existing historical calls are attached using an explicit, bounded backfill. After migrations, run from Backend:

```sh
npm run backfill:conversation-threads -- --apply --batch-size=200 --max-batches=10
```

Use `--tenant=<company UUID>` to restrict a run. Without `--apply`, nothing changes. Each batch commits separately; rerun as needed. Parallel workers skip locked calls, so a zero-sized batch does not prove another worker has finished. Rollback removes the new trigger/functions/index and retains contacts, threads and call links.

No `.env` changes are required. Run `node scripts/verify-conversation-thread-linking.js` for SQL contract and backfill fixture checks. Actual PostgreSQL trigger execution, simultaneous same-number inserts and RLS must also be verified in staging before release; local fixtures do not establish those results.
