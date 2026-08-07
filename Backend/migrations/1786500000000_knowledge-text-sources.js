export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE knowledge_documents
      DROP CONSTRAINT IF EXISTS knowledge_documents_pdf_only;

    ALTER TABLE knowledge_documents
      ADD CONSTRAINT knowledge_documents_source_type
      CHECK (lower(mime_type) IN ('application/pdf', 'text/plain'));
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE knowledge_documents
      DROP CONSTRAINT IF EXISTS knowledge_documents_source_type;

    ALTER TABLE knowledge_documents
      ADD CONSTRAINT knowledge_documents_pdf_only
      CHECK (lower(mime_type) = 'application/pdf') NOT VALID;
  `);
}
