import { withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';

function mapGroup(row) {
  return {
    id: row.id,
    companyId: row.tenant_id,
    name: row.name,
    language: row.language,
    status: row.status,
    description: row.description,
    ruleCount: Number(row.rule_count ?? 0),
    assignedAgentCount: Number(row.assigned_agent_count ?? 0),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRule(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    writtenText: row.source_text,
    spokenReplacement: row.spoken_text,
    matchType: row.match_type,
    caseSensitive: row.case_sensitive,
    priority: row.priority,
    enabled: row.enabled,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row) {
  return {
    agentId: row.agent_id,
    groupId: row.group_id,
    groupName: row.group_name,
    language: row.language,
    status: row.status,
    priority: row.priority,
    ruleCount: Number(row.rule_count ?? 0),
    assignedBy: row.assigned_by,
    assignedAt: row.created_at,
  };
}

async function writeAudit(client, auth, action, entityType, entityId, before, after) {
  await client.query(
    `INSERT INTO audit_logs (
       tenant_id, workspace_id, actor_user_id, actor_type, action,
       entity_type, entity_id, before_data, after_data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [
      auth.tenantId,
      auth.workspaceId,
      auth.userId ?? null,
      auth.authType === 'api_key' ? 'api' : 'user',
      action,
      entityType,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    ],
  );
}

async function groupRow(client, tenantId, groupId, lock = false) {
  const result = await client.query(
    `SELECT pg.*,
            (SELECT count(*)::int FROM pronunciation_rules pr
              WHERE pr.tenant_id=pg.tenant_id AND pr.group_id=pg.id AND pr.deleted_at IS NULL) AS rule_count,
            (SELECT count(*)::int FROM agent_pronunciation_groups apg
              WHERE apg.tenant_id=pg.tenant_id AND apg.group_id=pg.id) AS assigned_agent_count
       FROM pronunciation_groups pg
      WHERE pg.tenant_id=$1 AND pg.id=$2 AND pg.deleted_at IS NULL
      ${lock ? 'FOR UPDATE' : ''}`,
    [tenantId, groupId],
  );
  if (!result.rowCount) {
    throw new AppError(404, 'Pronunciation group was not found', 'PRONUNCIATION_GROUP_NOT_FOUND');
  }
  return result.rows[0];
}

async function ruleRow(client, tenantId, groupId, ruleId, lock = false) {
  const result = await client.query(
    `SELECT * FROM pronunciation_rules
      WHERE tenant_id=$1 AND group_id=$2 AND id=$3 AND deleted_at IS NULL
      ${lock ? 'FOR UPDATE' : ''}`,
    [tenantId, groupId, ruleId],
  );
  if (!result.rowCount) {
    throw new AppError(404, 'Pronunciation rule was not found', 'PRONUNCIATION_RULE_NOT_FOUND');
  }
  return result.rows[0];
}

function duplicateError(error, message, code) {
  if (error?.code === '23505') return new AppError(409, message, code);
  return error;
}

export function listPronunciationGroups(auth, filters, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const offset = (filters.page - 1) * filters.pageSize;
    const values = [auth.tenantId];
    const clauses = ['pg.tenant_id=$1', 'pg.deleted_at IS NULL'];
    if (filters.search) {
      values.push(`%${filters.search}%`);
      clauses.push(`pg.name ILIKE $${values.length}`);
    }
    if (filters.language) {
      values.push(filters.language);
      clauses.push(`lower(pg.language)=lower($${values.length})`);
    }
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`pg.status=$${values.length}`);
    }
    values.push(filters.pageSize, offset);
    const result = await client.query(
      `SELECT pg.*,
              count(*) OVER()::int AS total_count,
              (SELECT count(*)::int FROM pronunciation_rules pr
                WHERE pr.tenant_id=pg.tenant_id AND pr.group_id=pg.id AND pr.deleted_at IS NULL) AS rule_count,
              (SELECT count(*)::int FROM agent_pronunciation_groups apg
                WHERE apg.tenant_id=pg.tenant_id AND apg.group_id=pg.id) AS assigned_agent_count
         FROM pronunciation_groups pg
        WHERE ${clauses.join(' AND ')}
        ORDER BY lower(pg.name), pg.id
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      items: result.rows.map(mapGroup),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  });
}

export function getPronunciationGroup(auth, groupId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const group = mapGroup(await groupRow(client, auth.tenantId, groupId));
    const rules = await client.query(
      `SELECT * FROM pronunciation_rules
        WHERE tenant_id=$1 AND group_id=$2 AND deleted_at IS NULL
        ORDER BY priority, created_at, id`,
      [auth.tenantId, groupId],
    );
    return { ...group, rules: rules.rows.map(mapRule) };
  });
}

export function createPronunciationGroup(auth, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    try {
      const result = await client.query(
        `INSERT INTO pronunciation_groups (
           tenant_id, name, language, status, description, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [auth.tenantId, input.name, input.language, input.status, input.description, auth.userId ?? null],
      );
      const group = mapGroup(await groupRow(client, auth.tenantId, result.rows[0].id));
      await writeAudit(client, auth, 'PRONUNCIATION_GROUP_CREATED', 'pronunciation_group', group.id, null, group);
      return group;
    } catch (error) {
      throw duplicateError(error, 'A pronunciation group with this name already exists', 'PRONUNCIATION_GROUP_EXISTS');
    }
  });
}

export function updatePronunciationGroup(auth, groupId, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const beforeRow = await groupRow(client, auth.tenantId, groupId, true);
    const before = mapGroup(beforeRow);
    const next = {
      name: input.name ?? beforeRow.name,
      language: input.language ?? beforeRow.language,
      status: input.status ?? beforeRow.status,
      description: Object.hasOwn(input, 'description') ? input.description : beforeRow.description,
    };
    try {
      await client.query(
        `UPDATE pronunciation_groups
            SET name=$3, language=$4, status=$5, description=$6, updated_by=$7
          WHERE tenant_id=$1 AND id=$2`,
        [auth.tenantId, groupId, next.name, next.language, next.status, next.description, auth.userId ?? null],
      );
    } catch (error) {
      throw duplicateError(error, 'A pronunciation group with this name already exists', 'PRONUNCIATION_GROUP_EXISTS');
    }
    const after = mapGroup(await groupRow(client, auth.tenantId, groupId));
    await writeAudit(client, auth, 'PRONUNCIATION_GROUP_UPDATED', 'pronunciation_group', groupId, before, after);
    return after;
  });
}

export function deletePronunciationGroup(auth, groupId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const before = mapGroup(await groupRow(client, auth.tenantId, groupId, true));
    await client.query(
      `DELETE FROM agent_pronunciation_groups WHERE tenant_id=$1 AND group_id=$2`,
      [auth.tenantId, groupId],
    );
    await client.query(
      `UPDATE pronunciation_rules
          SET deleted_at=now(), enabled=false, updated_by=$3
        WHERE tenant_id=$1 AND group_id=$2 AND deleted_at IS NULL`,
      [auth.tenantId, groupId, auth.userId ?? null],
    );
    await client.query(
      `UPDATE pronunciation_groups
          SET deleted_at=now(), status='archived', updated_by=$3
        WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId, groupId, auth.userId ?? null],
    );
    await writeAudit(client, auth, 'PRONUNCIATION_GROUP_DELETED', 'pronunciation_group', groupId, before, null);
    return { id: groupId, deleted: true };
  });
}

export function createPronunciationRule(auth, groupId, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const group = await groupRow(client, auth.tenantId, groupId, true);
    if (group.status === 'archived') {
      throw new AppError(409, 'Archived pronunciation groups cannot be edited', 'PRONUNCIATION_GROUP_ARCHIVED');
    }
    try {
      const result = await client.query(
        `INSERT INTO pronunciation_rules (
           tenant_id, group_id, source_text, spoken_text, match_type,
           case_sensitive, priority, enabled, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [auth.tenantId, groupId, input.sourceText, input.spokenText, input.matchType,
          input.caseSensitive, input.priority, input.enabled, auth.userId ?? null],
      );
      const rule = mapRule(result.rows[0]);
      await writeAudit(client, auth, 'PRONUNCIATION_RULE_CREATED', 'pronunciation_rule', rule.id, null, rule);
      return rule;
    } catch (error) {
      throw duplicateError(error, 'This written text already has a rule in the group', 'PRONUNCIATION_RULE_EXISTS');
    }
  });
}

export function updatePronunciationRule(auth, groupId, ruleId, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    const group = await groupRow(client, auth.tenantId, groupId, true);
    if (group.status === 'archived') {
      throw new AppError(409, 'Archived pronunciation groups cannot be edited', 'PRONUNCIATION_GROUP_ARCHIVED');
    }
    const beforeRow = await ruleRow(client, auth.tenantId, groupId, ruleId, true);
    const before = mapRule(beforeRow);
    const next = {
      sourceText: input.sourceText ?? beforeRow.source_text,
      spokenText: input.spokenText ?? beforeRow.spoken_text,
      matchType: input.matchType ?? beforeRow.match_type,
      caseSensitive: input.caseSensitive ?? beforeRow.case_sensitive,
      priority: input.priority ?? beforeRow.priority,
      enabled: input.enabled ?? beforeRow.enabled,
    };
    try {
      await client.query(
        `UPDATE pronunciation_rules
            SET source_text=$4, spoken_text=$5, match_type=$6, case_sensitive=$7,
                priority=$8, enabled=$9, updated_by=$10
          WHERE tenant_id=$1 AND group_id=$2 AND id=$3`,
        [auth.tenantId, groupId, ruleId, next.sourceText, next.spokenText, next.matchType,
          next.caseSensitive, next.priority, next.enabled, auth.userId ?? null],
      );
    } catch (error) {
      throw duplicateError(error, 'This written text already has a rule in the group', 'PRONUNCIATION_RULE_EXISTS');
    }
    const after = mapRule(await ruleRow(client, auth.tenantId, groupId, ruleId));
    await writeAudit(client, auth, 'PRONUNCIATION_RULE_UPDATED', 'pronunciation_rule', ruleId, before, after);
    return after;
  });
}

export function deletePronunciationRule(auth, groupId, ruleId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    await groupRow(client, auth.tenantId, groupId, true);
    const before = mapRule(await ruleRow(client, auth.tenantId, groupId, ruleId, true));
    await client.query(
      `UPDATE pronunciation_rules
          SET deleted_at=now(), enabled=false, updated_by=$4
        WHERE tenant_id=$1 AND group_id=$2 AND id=$3`,
      [auth.tenantId, groupId, ruleId, auth.userId ?? null],
    );
    await writeAudit(client, auth, 'PRONUNCIATION_RULE_DELETED', 'pronunciation_rule', ruleId, before, null);
    return { id: ruleId, groupId, deleted: true };
  });
}

async function assertAgent(client, auth, agentId, lock = false) {
  const result = await client.query(
    `SELECT id FROM voice_agents
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
        AND deleted_at IS NULL AND status<>'archived'
      ${lock ? 'FOR UPDATE' : ''}`,
    [auth.tenantId, auth.workspaceId, agentId],
  );
  if (!result.rowCount) throw new AppError(404, 'Voice agent was not found', 'AGENT_NOT_FOUND');
}

async function assignmentRows(client, tenantId, agentId) {
  const result = await client.query(
    `SELECT apg.agent_id, apg.group_id, apg.priority, apg.assigned_by, apg.created_at,
            pg.name AS group_name, pg.language, pg.status,
            (SELECT count(*)::int FROM pronunciation_rules pr
              WHERE pr.tenant_id=pg.tenant_id AND pr.group_id=pg.id
                AND pr.deleted_at IS NULL AND pr.enabled=true) AS rule_count
       FROM agent_pronunciation_groups apg
       JOIN pronunciation_groups pg
         ON pg.tenant_id=apg.tenant_id AND pg.id=apg.group_id
      WHERE apg.tenant_id=$1 AND apg.agent_id=$2 AND pg.deleted_at IS NULL
      ORDER BY apg.priority, apg.created_at, apg.group_id`,
    [tenantId, agentId],
  );
  return result.rows.map(mapAssignment);
}

export function listAgentPronunciationGroups(auth, agentId, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    await assertAgent(client, auth, agentId);
    return assignmentRows(client, auth.tenantId, agentId);
  });
}

export function replaceAgentPronunciationGroups(auth, agentId, input, contextRunner = withTenantContext) {
  return contextRunner(auth, async (client) => {
    await assertAgent(client, auth, agentId, true);
    const before = await assignmentRows(client, auth.tenantId, agentId);
    if (input.groupIds.length) {
      const available = await client.query(
        `SELECT id FROM pronunciation_groups
          WHERE tenant_id=$1 AND id=ANY($2::uuid[])
            AND status='active' AND deleted_at IS NULL
          FOR SHARE`,
        [auth.tenantId, input.groupIds],
      );
      if (available.rowCount !== input.groupIds.length) {
        throw new AppError(
          409,
          'One or more pronunciation groups are unavailable for this company',
          'AGENT_PRONUNCIATION_GROUP_UNAVAILABLE',
        );
      }
    }
    await client.query(
      'DELETE FROM agent_pronunciation_groups WHERE tenant_id=$1 AND agent_id=$2',
      [auth.tenantId, agentId],
    );
    if (input.groupIds.length) {
      await client.query(
        `INSERT INTO agent_pronunciation_groups (
           tenant_id, agent_id, group_id, priority, assigned_by
         )
         SELECT $1, $2, selected.group_id, ((selected.position - 1) * 100)::integer, $4
           FROM unnest($3::uuid[]) WITH ORDINALITY AS selected(group_id, position)`,
        [auth.tenantId, agentId, input.groupIds, auth.userId ?? null],
      );
    }
    const after = await assignmentRows(client, auth.tenantId, agentId);
    await writeAudit(
      client,
      auth,
      'AGENT_PRONUNCIATION_GROUPS_REPLACED',
      'voice_agent',
      agentId,
      { groupIds: before.map((item) => item.groupId) },
      { groupIds: after.map((item) => item.groupId) },
    );
    return after;
  });
}
