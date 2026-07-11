import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

type WalletErrorCode =
  | 'WALLET_ADDRESS_IN_USE'
  | 'WALLET_LIMIT_REACHED'
  | 'SIWE_NONCE_INVALID'
  | 'SIWE_NONCE_EXPIRED'
  | 'SIWE_SIGNATURE_INVALID'
  | 'UNSUPPORTED_CHAIN'
  | 'PRIVY_DISABLED'
  | 'PRIVY_UNAVAILABLE'
  | 'PRIVY_WALLET_NOT_READY'
  | 'WALLET_NOT_FOUND';

function body(code: WalletErrorCode, message: string) {
  return { code, message };
}

export class WalletAddressInUseException extends ConflictException {
  constructor() {
    super(body('WALLET_ADDRESS_IN_USE', 'Wallet address is already linked to another account'));
  }
}

export class WalletLimitReachedException extends ConflictException {
  constructor() {
    super(body('WALLET_LIMIT_REACHED', 'External wallet limit has been reached'));
  }
}

export class SiweNonceInvalidException extends UnauthorizedException {
  constructor() {
    super(body('SIWE_NONCE_INVALID', 'SIWE nonce is invalid or has already been used'));
  }
}

export class SiweNonceExpiredException extends UnauthorizedException {
  constructor() {
    super(body('SIWE_NONCE_EXPIRED', 'SIWE nonce has expired'));
  }
}

export class SiweSignatureInvalidException extends UnauthorizedException {
  constructor() {
    super(body('SIWE_SIGNATURE_INVALID', 'SIWE signature is invalid'));
  }
}

export class UnsupportedChainException extends BadRequestException {
  constructor() {
    super(body('UNSUPPORTED_CHAIN', 'Only Arbitrum One chain ID 42161 is supported'));
  }
}

export class PrivyDisabledException extends ServiceUnavailableException {
  constructor() {
    super(body('PRIVY_DISABLED', 'Embedded wallets are not configured'));
  }
}

export class PrivyUnavailableException extends ServiceUnavailableException {
  constructor() {
    super(body('PRIVY_UNAVAILABLE', 'Privy is temporarily unavailable'));
  }
}

export class PrivyWalletNotReadyException extends ConflictException {
  constructor(message = 'Privy embedded wallet is not ready yet') {
    super(body('PRIVY_WALLET_NOT_READY', message));
  }
}

export class WalletNotFoundException extends NotFoundException {
  constructor() {
    super(body('WALLET_NOT_FOUND', 'Wallet was not found'));
  }
}
