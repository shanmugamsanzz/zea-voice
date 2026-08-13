import { env } from '../config/env.js';
import { measureExternalProvider } from '../performance/performance-context.js';
import {
  DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';

let storageClient;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function knowledgeBaseB2Prefix({ tenantId, knowledgeBaseId }) {
  const normalizedTenantId = String(tenantId ?? '').toLowerCase();
  const normalizedKnowledgeBaseId = String(knowledgeBaseId ?? '').toLowerCase();
  if (!uuidPattern.test(normalizedTenantId) || !uuidPattern.test(normalizedKnowledgeBaseId)) {
    throw new TypeError('Valid tenant and Knowledge Base IDs are required for B2 cleanup');
  }
  return `tenants/${normalizedTenantId}/knowledge-bases/${normalizedKnowledgeBaseId}/`;
}

export function knowledgeDocumentB2Prefix({ tenantId, knowledgeBaseId, documentId }) {
  const normalizedDocumentId = String(documentId ?? '').toLowerCase();
  if (!uuidPattern.test(normalizedDocumentId)) {
    throw new TypeError('A valid document ID is required for B2 cleanup');
  }
  return `${knowledgeBaseB2Prefix({ tenantId, knowledgeBaseId })}documents/${normalizedDocumentId}/`;
}

function requiredStorageConfig() {
  const missing = [
    ['B2_S3_ENDPOINT', env.B2_S3_ENDPOINT],
    ['B2_REGION', env.B2_REGION],
    ['B2_BUCKET', env.B2_BUCKET],
    ['B2_KEY_ID', env.B2_KEY_ID],
    ['B2_APPLICATION_KEY', env.B2_APPLICATION_KEY],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Backblaze B2 storage requires ${missing.join(', ')}`);
}

function getStorageClient() {
  requiredStorageConfig();
  storageClient ??= new S3Client({
    endpoint: env.B2_S3_ENDPOINT,
    region: env.B2_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.B2_KEY_ID,
      secretAccessKey: env.B2_APPLICATION_KEY,
    },
    maxAttempts: 3,
  });
  return storageClient;
}

async function fetchB2Json(url, options, operation) {
  return measureExternalProvider('backblaze-b2', operation, async () => {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Backblaze B2 request failed with HTTP ${response.status} (${payload?.code ?? 'B2_REQUEST_FAILED'})`);
    }
    return payload;
  });
}

export async function checkB2() {
  const startedAt = performance.now();
  const basicToken = Buffer.from(`${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`).toString('base64');
  const authorization = await fetchB2Json('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: { authorization: `Basic ${basicToken}` },
  }, 'authorize');
  const storageApi = authorization.apiInfo?.storageApi;
  if (!storageApi?.apiUrl || !authorization.authorizationToken || !authorization.accountId) {
    throw new Error('Backblaze B2 authorization response was incomplete');
  }

  const buckets = await fetchB2Json(`${storageApi.apiUrl}/b2api/v4/b2_list_buckets`, {
    method: 'POST',
    headers: {
      authorization: authorization.authorizationToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ accountId: authorization.accountId, bucketId: env.B2_BUCKET_ID }),
  }, 'list-bucket');
  const bucket = buckets.buckets?.find((entry) => entry.bucketId === env.B2_BUCKET_ID);
  if (!bucket || bucket.bucketName !== env.B2_BUCKET) {
    throw new Error('Configured Backblaze B2 bucket is not accessible');
  }
  if (bucket.bucketType !== 'allPrivate') {
    throw new Error('Configured Backblaze B2 bucket must be private (allPrivate)');
  }

  return { ok: true, latencyMs: Math.round((performance.now() - startedAt) * 100) / 100 };
}

export async function putB2Object({ key, body, contentType, metadata = {} }) {
  if (!Buffer.isBuffer(body)) throw new TypeError('Backblaze B2 upload body must be a Buffer');
  return measureExternalProvider('backblaze-b2', 'put-object', async () => {
    const result = await getStorageClient().send(new PutObjectCommand({
      Bucket: env.B2_BUCKET,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
      Metadata: Object.fromEntries(Object.entries(metadata).map(([name, value]) => [name, String(value)])),
    }), { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) });
    return {
      bucket: env.B2_BUCKET,
      key,
      etag: result.ETag?.replaceAll('"', '') ?? null,
      storageVersionId: result.VersionId ?? null,
    };
  });
}

export async function getB2Object({ key, versionId = undefined, maxBytes = undefined }) {
  return measureExternalProvider('backblaze-b2', 'get-object', async () => {
    const result = await getStorageClient().send(
      new GetObjectCommand({ Bucket: env.B2_BUCKET, Key: key, VersionId: versionId }),
      { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) },
    );
    if (!result.Body) throw new Error('Backblaze B2 returned an empty object body');
    if (maxBytes && Number(result.ContentLength ?? 0) > maxBytes) {
      throw new Error(`Backblaze B2 object exceeds the ${maxBytes}-byte download limit`);
    }
    const bytes = await result.Body.transformToByteArray();
    if (maxBytes && bytes.length > maxBytes) {
      throw new Error(`Backblaze B2 object exceeds the ${maxBytes}-byte download limit`);
    }
    return {
      bucket: env.B2_BUCKET,
      key,
      versionId: result.VersionId ?? versionId ?? null,
      contentType: result.ContentType ?? null,
      metadata: result.Metadata ?? {},
      body: Buffer.from(bytes),
    };
  });
}

export async function deleteB2Object({ key, versionId = undefined }) {
  return measureExternalProvider('backblaze-b2', 'delete-object', async () => {
    await getStorageClient().send(
      new DeleteObjectCommand({ Bucket: env.B2_BUCKET, Key: key, VersionId: versionId }),
      { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) },
    );
    return { bucket: env.B2_BUCKET, key, versionId: versionId ?? null, deleted: true };
  });
}

export async function deleteAllB2ObjectVersions({ key }) {
  return measureExternalProvider('backblaze-b2', 'delete-object-versions', async () => {
    let keyMarker;
    let versionIdMarker;
    let deletedCount = 0;
    let truncated;
    do {
      const listed = await getStorageClient().send(new ListObjectVersionsCommand({
        Bucket: env.B2_BUCKET,
        Prefix: key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
        MaxKeys: 1000,
      }), { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) });
      const entries = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((entry) => entry.Key === key && entry.VersionId);
      for (const entry of entries) {
        await getStorageClient().send(new DeleteObjectCommand({
          Bucket: env.B2_BUCKET, Key: key, VersionId: entry.VersionId,
        }), { abortSignal: AbortSignal.timeout(env.PROVIDER_REQUEST_TIMEOUT_MS) });
        deletedCount += 1;
      }
      truncated = Boolean(listed.IsTruncated);
      keyMarker = truncated ? listed.NextKeyMarker : undefined;
      versionIdMarker = truncated ? listed.NextVersionIdMarker : undefined;
      if (truncated && !keyMarker && !versionIdMarker) {
        throw new Error('B2 object-version listing was truncated without continuation markers');
      }
    } while (truncated);
    return { bucket: env.B2_BUCKET, key, deletedCount, deleted: true };
  });
}

async function deleteAllB2ObjectsUnderPrefixInternal(normalizedPrefix, dependencies = {}) {
  return measureExternalProvider('backblaze-b2', 'delete-prefix-versions', async () => {
    const client = dependencies.client ?? getStorageClient();
    const bucket = dependencies.bucket ?? env.B2_BUCKET;
    const timeoutMs = dependencies.timeoutMs ?? env.PROVIDER_REQUEST_TIMEOUT_MS;
    let deletedCount = 0;
    let deletedVersionCount = 0;
    let deletedMarkerCount = 0;
    let listPasses = 0;
    // Always restart the listing after deleting a page. This avoids skipping
    // versions when the remote listing changes while it is being consumed.
    for (;;) {
      listPasses += 1;
      const listed = await client.send(new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: normalizedPrefix,
        MaxKeys: 1000,
      }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      const entries = [
        ...(listed.Versions ?? []).map((entry) => ({ ...entry, entryType: 'version' })),
        ...(listed.DeleteMarkers ?? []).map((entry) => ({ ...entry, entryType: 'delete_marker' })),
      ].filter((entry) => entry.Key?.startsWith(normalizedPrefix) && entry.VersionId);
      if (!entries.length) {
        if (listed.IsTruncated) {
          throw new Error('B2 prefix listing was truncated without deletable object versions');
        }
        break;
      }
      for (const entry of entries) {
        await client.send(new DeleteObjectCommand({
          Bucket: bucket,
          Key: entry.Key,
          VersionId: entry.VersionId,
        }), { abortSignal: AbortSignal.timeout(timeoutMs) });
        deletedCount += 1;
        if (entry.entryType === 'delete_marker') deletedMarkerCount += 1;
        else deletedVersionCount += 1;
      }
    }
    return {
      bucket,
      prefix: normalizedPrefix,
      deletedCount,
      deletedVersionCount,
      deletedMarkerCount,
      listPasses,
      deleted: true,
      verified: true,
      remainingObjectVersions: 0,
    };
  });
}

export async function deleteAllB2ObjectsUnderPrefix(
  { prefix, tenantId, knowledgeBaseId },
  dependencies = {},
) {
  const normalizedPrefix = String(prefix ?? '');
  const expectedPrefix = knowledgeBaseB2Prefix({ tenantId, knowledgeBaseId });
  if (normalizedPrefix !== expectedPrefix) {
    throw new TypeError('A tenant-isolated Knowledge Base storage prefix is required');
  }
  return deleteAllB2ObjectsUnderPrefixInternal(normalizedPrefix, dependencies);
}

export async function deleteAllB2ObjectsUnderDocumentPrefix(
  { prefix, tenantId, knowledgeBaseId, documentId },
  dependencies = {},
) {
  const normalizedPrefix = String(prefix ?? '');
  const expectedPrefix = knowledgeDocumentB2Prefix({ tenantId, knowledgeBaseId, documentId });
  if (normalizedPrefix !== expectedPrefix) {
    throw new TypeError('A tenant-isolated Knowledge document storage prefix is required');
  }
  return deleteAllB2ObjectsUnderPrefixInternal(normalizedPrefix, dependencies);
}
