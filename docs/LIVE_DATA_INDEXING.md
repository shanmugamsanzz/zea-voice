# Live Data indexing limits

New grid saves and row additions support at most 50 data rows per table (header excluded). Oversized saves fail before deletion; rows are never silently truncated. Existing larger tables remain readable and indexable; row editing/deletion remains available, while full-grid saves must meet the new limit.

Indexing embeds sequential batches of at most 32 inputs. A 50-row table uses 32 + 18. Every batch must return valid embeddings in row order before the existing Qdrant table index is deleted. Sync is marked successful only after the replacement upsert completes. Embedding failures preserve the previous index; Qdrant delete/upsert replacement is not atomic, so a Qdrant failure during replacement can still require retrying sync.

This changes neither the embedding server limit nor answer retrieval. The current retrieval still selects table IDs via shared KB/Live Data ranking and supplies up to two tables, with up to 500 current rows per table.

After deploying backend and frontend, retry a failed table using Save changes in Live Data. Check its Index status and hover over a failure badge for the stored error. No database migration is required; existing data is not automatically removed or reindexed by deployment.

Verification (from Backend):

```sh
node scripts/verify-agent-live-data-index.js
node scripts/verify-agent-live-data-retrieval.js
```
