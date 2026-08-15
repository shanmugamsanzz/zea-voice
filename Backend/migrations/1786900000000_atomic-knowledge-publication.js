export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE knowledge_bases
      ADD COLUMN pending_publication_revision integer;

    UPDATE knowledge_bases kb
       SET pending_publication_revision=kb.publication_revision,
           publication_revision=GREATEST(kb.publication_revision-1, 0),
           status='processing', published_at=NULL, published_by=NULL
     WHERE kb.status IN ('published','partially_failed')
       AND EXISTS (
         SELECT 1 FROM knowledge_processing_jobs j
          WHERE j.tenant_id=kb.tenant_id AND j.knowledge_base_id=kb.id
            AND j.job_type='index' AND j.status IN ('queued','running')
            AND j.metadata->>'publicationRevision'=kb.publication_revision::text
       );

    ALTER TABLE knowledge_bases
      ADD CONSTRAINT knowledge_bases_pending_revision_valid CHECK (
        pending_publication_revision IS NULL
        OR pending_publication_revision > publication_revision
      );

    CREATE INDEX knowledge_bases_pending_publication_idx
      ON knowledge_bases (tenant_id, pending_publication_revision)
      WHERE pending_publication_revision IS NOT NULL AND deleted_at IS NULL;

    COMMENT ON COLUMN knowledge_bases.publication_revision IS
      'Only the fully verified active PostgreSQL/Qdrant/Redis publication revision.';
    COMMENT ON COLUMN knowledge_bases.pending_publication_revision IS
      'Revision being built; never visible to runtime retrieval until atomically activated.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS knowledge_bases_pending_publication_idx;
    ALTER TABLE knowledge_bases DROP CONSTRAINT IF EXISTS knowledge_bases_pending_revision_valid;
    ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS pending_publication_revision;
  `);
}
