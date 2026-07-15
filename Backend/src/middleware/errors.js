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
