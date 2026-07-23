import { logger } from '../config/logger.js';

export class AppError extends Error {
  constructor(statusCode, message, code = 'APPLICATION_ERROR', details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const notFoundHandler = (request, _response, next) => {
  next(new AppError(404, `Route ${request.method} ${request.path} was not found`, 'ROUTE_NOT_FOUND'));
};

export const errorHandler = (error, request, response, _next) => {
  if (error instanceof AppError) {
    if (request.path?.startsWith('/webhooks/plivo')) {
      request.log?.warn({
        icon: '❌',
        stage: 'voice.webhook_failed',
        statusCode: error.statusCode,
        errorCode: error.code,
        requestId: request.id,
      }, `❌ Voice call stage failed: ${error.message}`);
    }
    response.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message, details: error.details },
      requestId: request.id,
    });
    return;
  }

  logger.error({ err: error, requestId: request.id }, 'Unhandled request error');
  response.status(500).json({
    success: false,
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' },
    requestId: request.id,
  });
};
