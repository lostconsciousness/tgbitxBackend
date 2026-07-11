import { Injectable } from '@nestjs/common';
import { SwapProvider, SwapQuote, SwapQuoteRequest } from './swap-provider.interface';

@Injectable()
export class InternalSwapProviderService implements SwapProvider {
  async getQuote(_request: SwapQuoteRequest): Promise<SwapQuote> {
    throw new Error('Internal spot swap quotes are not exposed yet');
  }
}
