import { Router } from 'express';
import multer from 'multer';
import { requireRoles } from '../auth/auth.middleware.js';
import { AppError } from '../middleware/errors.js';
import { AGENT_TEXT_DOCUMENT_LIMITS } from '../voice/interaction/agent-text-document-contract.js';
import {
  deleteAgentQdrantDocument,
  listAgentQdrantDocuments,
  replaceAgentQdrantDocument,
  uploadAgentQdrantDocuments,
} from './agent-qdrant-document.service.js';

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: AGENT_TEXT_DOCUMENT_LIMITS.maximumFilesPerUpload,
    fileSize: AGENT_TEXT_DOCUMENT_LIMITS.maximumBytesPerFile,
    fields: 2,
  },
});
const write = requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER');

function auth(request) {
  return {
    ...request.auth,
    tenantId: request.tenant.tenantId,
    workspaceId: request.tenant.workspaceId,
  };
}

function receive(handler) {
  return (request, response, next) => handler(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? `Each text document must not exceed ${AGENT_TEXT_DOCUMENT_LIMITS.maximumBytesPerFile} bytes`
        : error.message;
      next(new AppError(400, message, 'TEXT_DOCUMENT_MULTIPART_INVALID'));
      return;
    }
    next(error);
  });
}

function invalidUpload(error) {
  if (!(error instanceof TypeError)) throw error;
  throw new AppError(400, error.message, 'TEXT_DOCUMENT_UPLOAD_INVALID');
}

export const agentQdrantDocumentRouter = Router({ mergeParams: true });

agentQdrantDocumentRouter.get('/', async (request, response) => {
  response.json({
    success: true,
    data: await listAgentQdrantDocuments(auth(request), request.params.agentId),
  });
});

agentQdrantDocumentRouter.post('/', write, receive(
  multipart.array('files', AGENT_TEXT_DOCUMENT_LIMITS.maximumFilesPerUpload),
), async (request, response) => {
  try {
    const data = await uploadAgentQdrantDocuments(
      auth(request), request.params.agentId, request.files,
    );
    response.status(201).json({ success: true, data });
  } catch (error) {
    invalidUpload(error);
  }
});

agentQdrantDocumentRouter.put('/:documentId', write, receive(
  multipart.single('file'),
), async (request, response) => {
  try {
    const data = await replaceAgentQdrantDocument(
      auth(request), request.params.agentId, request.params.documentId, request.file,
    );
    response.json({ success: true, data });
  } catch (error) {
    invalidUpload(error);
  }
});

agentQdrantDocumentRouter.delete('/:documentId', write, async (request, response) => {
  response.json({
    success: true,
    data: await deleteAgentQdrantDocument(
      auth(request), request.params.agentId, request.params.documentId,
    ),
  });
});
