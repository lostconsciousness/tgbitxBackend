import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

export class MarketDataUnavailableException extends ServiceUnavailableException {
  constructor(message = 'Market data provider is unavailable') {
    super(message);
  }
}

export class OrderBookNotEnabledException extends BadRequestException {
  constructor() {
    super('Order book is not enabled for this market');
  }
}

export class MarketNotTradableException extends BadRequestException {
  constructor() {
    super('Market is not active');
  }
}

export class MarketDataMarketNotFoundException extends NotFoundException {
  constructor() {
    super('Market was not found');
  }
}
