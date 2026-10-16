export async function up(pgm) {
  pgm.sql(`ALTER TABLE agent_call_transfer_settings ADD COLUMN callback_tool_id uuid
    REFERENCES agent_tools(id) ON DELETE SET NULL;
    ALTER TABLE call_transfer_attempts ADD COLUMN callback_tool_id uuid
    REFERENCES agent_tools(id) ON DELETE SET NULL;
    ALTER TABLE call_transfer_attempts ADD COLUMN resume_xml text;`);
}
export async function down(pgm) {
  pgm.sql(`ALTER TABLE call_transfer_attempts DROP COLUMN resume_xml;
    ALTER TABLE call_transfer_attempts DROP COLUMN callback_tool_id;
    ALTER TABLE agent_call_transfer_settings DROP COLUMN callback_tool_id;`);
}
