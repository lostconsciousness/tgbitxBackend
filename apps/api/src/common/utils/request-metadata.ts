import { Request } from 'express';

export function getRequestMetadata(request: Request): { userAgent?: string; ipAddress?: string } {
  return {
    userAgent: request.get('user-agent'),
    ipAddress: request.ip,
  };
}
