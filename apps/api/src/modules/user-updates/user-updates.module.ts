import { Global, Module } from '@nestjs/common';
import { UserUpdatesService } from './user-updates.service';

@Global()
@Module({
  providers: [UserUpdatesService],
  exports: [UserUpdatesService],
})
export class UserUpdatesModule {}
