export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    -- Existing providers predate Runtime Connection Type. Assign an adapter
    -- only when the provider's service type and identity identify it clearly.
    WITH identified AS (
      SELECT id, type,
        regexp_replace(lower(slug), '[^a-z0-9]', '', 'g') AS identity
      FROM ai_providers
      WHERE runtime_connection_type IS NULL AND deleted_at IS NULL
    )
    UPDATE ai_providers AS provider
      SET runtime_connection_type = CASE
        WHEN identified.type = 'stt' THEN CASE
          WHEN identified.identity IN ('sarvam', 'sarvamai', 'sarvamstt') THEN 'sarvam'
          WHEN identified.identity IN ('cartesia', 'cartesiaai', 'cartesiastt') THEN 'cartesia'
          WHEN identified.identity IN ('elevenlabs', 'elevenlabsstt', '11labs') THEN 'elevenlabs'
        END
        WHEN identified.type = 'tts' THEN CASE
          WHEN identified.identity IN ('cartesia', 'cartesiaai', 'cartesiatts') THEN 'cartesia'
          WHEN identified.identity IN ('sarvam', 'sarvamai', 'sarvamtts') THEN 'sarvam'
          WHEN identified.identity IN ('elevenlabs', 'elevenlabstts', '11labs') THEN 'elevenlabs'
          WHEN identified.identity IN ('azure', 'azuretts', 'azurespeech', 'microsoftazurespeech') THEN 'azure'
        END
        WHEN identified.type = 'llm' THEN CASE
          WHEN identified.identity IN ('openai', 'llmopenai') THEN 'openai'
          WHEN identified.identity IN ('gemini', 'googlegemini', 'googleai') THEN 'gemini'
          WHEN identified.identity IN ('anthropic', 'claude', 'anthropicclaude') THEN 'anthropic'
          WHEN identified.identity IN ('groq', 'llmgroq') THEN 'groq'
          WHEN identified.identity IN ('azureopenai', 'llmazureopenai') THEN 'azure_openai'
        END
      END
    FROM identified
    WHERE provider.id = identified.id
      AND (
        (identified.type = 'stt' AND identified.identity IN
          ('sarvam', 'sarvamai', 'sarvamstt', 'cartesia', 'cartesiaai', 'cartesiastt',
           'elevenlabs', 'elevenlabsstt', '11labs'))
        OR (identified.type = 'tts' AND identified.identity IN
          ('cartesia', 'cartesiaai', 'cartesiatts', 'sarvam', 'sarvamai', 'sarvamtts',
           'elevenlabs', 'elevenlabstts', '11labs', 'azure', 'azuretts',
           'azurespeech', 'microsoftazurespeech'))
        OR (identified.type = 'llm' AND identified.identity IN
          ('openai', 'llmopenai', 'gemini', 'googlegemini', 'googleai',
           'anthropic', 'claude', 'anthropicclaude', 'groq', 'llmgroq',
           'azureopenai', 'llmazureopenai'))
      );
  `);
}

export async function down() {
  // This backfill cannot distinguish a migrated value from a later admin edit.
  // Keep the explicit provider connection instead of clearing it on rollback.
}
