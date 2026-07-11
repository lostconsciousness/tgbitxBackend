import { UserRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  sid: string;
  email: string;
  role: UserRole;
}
