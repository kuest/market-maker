import {
  AssetType,
  createPublicClient,
  createSecureClient,
  forkEnvironmentConfig,
  OrderSide,
  WalletType,
  type SignedOrder,
} from "@kuest/sdk";
import { loadSiteConfig } from "@kuest/sdk/node";
import { fetchBalanceAllowance, isWalletDeployed } from "@kuest/sdk/actions";
import { privateKey } from "@kuest/sdk/viem";
import type { Config } from "./config.js";
import { siteConditionIds } from "./event-scope.js";

// Keep the strategy's established CLOB data shape at this one boundary. The
// unified SDK returns normalized, camel-case models and cursor paginators.
export const Side = OrderSide;
export type Side = OrderSide;
export { AssetType };
export type OrderSummary = { price: string; size: string };
export type OrderBookSummary = {
  market: string;
  asset_id: string;
  timestamp: string;
  bids: OrderSummary[];
  asks: OrderSummary[];
  min_order_size: string;
  tick_size: string;
  neg_risk: boolean;
  last_trade_price: string;
  hash: string;
};
export type OpenOrder = {
  id: string; status: string; owner: string; maker_address: string;
  market: string; asset_id: string; side: string; original_size: string;
  size_matched: string; price: string; associate_trades: string[];
  outcome: string; created_at: number; expiration: string; order_type: string;
};
export type Trade = {
  id: string; market: string; asset_id: string; side: Side;
  size: string; price: string; status: string; match_time: string;
};
export type OrderResponse = {
  success: boolean; errorMsg: string; orderID: string;
  status: string; makingAmount: string; takingAmount: string;
  transactionsHashes: string[];
};
export type PaginationPayload = { data: Record<string, unknown>[]; next_cursor: string; count: number; limit: number };

export class UnifiedMarketClient {
  private scopePromise?: Promise<Set<string>>;

  private constructor(
    private readonly config: Config,
    private readonly client: ReturnType<typeof createPublicClient> | Awaited<ReturnType<typeof createSecureClient>>,
    private readonly secure?: Awaited<ReturnType<typeof createSecureClient>>,
    private readonly postOnly = true,
  ) {}

  static public(config: Config): UnifiedMarketClient {
    return new UnifiedMarketClient(config, createPublicClient(options(config)));
  }

  static async secure(config: Config): Promise<UnifiedMarketClient> {
    if (!config.privateKey || !config.depositWallet) {
      throw new Error("Live mode requires a signer and existing Deposit Wallet");
    }
    const sdkOptions = options(config);
    const publicClient = createPublicClient(sdkOptions);
    if (!await isWalletDeployed(publicClient, {
      wallet: config.depositWallet, type: WalletType.DEPOSIT_WALLET,
    })) {
      throw new Error("The configured Deposit Wallet is not deployed; this bot will not deploy it");
    }
    const secure = await createSecureClient({
      ...sdkOptions, signer: privateKey(config.privateKey), wallet: config.depositWallet,
    });
    return new UnifiedMarketClient(config, secure, secure, config.postOnly);
  }

  private authenticated() {
    if (!this.secure) throw new Error("Authenticated SDK client is required");
    return this.secure;
  }

  async getMarket(conditionId: string): Promise<Record<string, unknown> | null> {
    const scope = await this.allowedConditionIds();
    if (scope && !scope.has(conditionId.toLowerCase())) return null;
    const url = new URL(`markets/${encodeURIComponent(conditionId)}`, withTrailingSlash(this.config.clobHost));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`CLOB market request failed: HTTP ${response.status}`);
    const market: unknown = await response.json();
    if (!isRecord(market)) throw new Error("CLOB market response must be an object");
    return market;
  }

  async getMarkets(cursor?: string): Promise<PaginationPayload> {
    return this.marketPage("markets", cursor);
  }

  async getSamplingMarkets(cursor?: string): Promise<PaginationPayload> {
    return this.marketPage("sampling-markets", cursor);
  }

  private async marketPage(path: string, initialCursor?: string): Promise<PaginationPayload> {
    const scope = await this.allowedConditionIds();
    let cursor = initialCursor ?? "MA==";
    for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
      const url = new URL(path, withTrailingSlash(this.config.clobHost));
      url.searchParams.set("next_cursor", cursor);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`CLOB ${path} request failed: HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.data) || typeof payload.next_cursor !== "string") {
        throw new Error(`CLOB ${path} page has an invalid response`);
      }
      const data = payload.data.filter(isRecord).filter((market) =>
        !scope || (typeof market.condition_id === "string" && scope.has(market.condition_id.toLowerCase())),
      );
      const page = {
        data, next_cursor: payload.next_cursor, count: data.length,
        limit: typeof payload.limit === "number" ? payload.limit : data.length,
      };
      if (!scope || data.length || page.next_cursor === "LTE=" || page.next_cursor === cursor) return page;
      cursor = page.next_cursor;
    }
    throw new Error(`CLOB ${path} site scope exceeded 50 pages`);
  }

  private async allowedConditionIds(): Promise<Set<string> | undefined> {
    const siteUrl = loadSiteConfig().site_url.trim();
    if (!siteUrl) return undefined;
    this.scopePromise ??= siteConditionIds(siteUrl);
    return this.scopePromise;
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSummary> {
    const book = await this.client.fetchOrderBook({ assetId: tokenId });
    return {
      market: book.conditionId, asset_id: book.assetId, timestamp: String(book.timestamp ?? ""),
      bids: book.bids, asks: book.asks, min_order_size: book.minOrderSize,
      tick_size: String(book.tickSize), neg_risk: book.negRisk,
      last_trade_price: book.lastTradePrice ?? "", hash: book.hash,
    };
  }

  async getOpenOrders({ asset_id }: { asset_id?: string }): Promise<OpenOrder[]> {
    const result: OpenOrder[] = [];
    for await (const page of this.authenticated().listOpenOrders({ assetId: asset_id })) {
      for (const order of page.items) result.push({
        id: order.id, status: order.status, owner: order.owner,
        maker_address: order.makerAddress, market: order.conditionId,
        asset_id: order.assetId, side: order.side, original_size: order.originalSize,
        size_matched: order.sizeMatched, price: order.price,
        associate_trades: order.associateTrades, outcome: order.outcome,
        created_at: Date.parse(order.createdAt) / 1000,
        expiration: order.expiresAt ?? "", order_type: order.orderType,
      });
    }
    return result;
  }

  async getTradesPaginated({ asset_id, after }: { asset_id?: string; after?: string }, cursor?: string) {
    const paginator = this.authenticated().listAccountTrades({ assetId: asset_id, after });
    const page = await (cursor ? paginator.from(cursor as never) : paginator).firstPage();
    return {
      trades: page.items.map((trade): Trade => ({
        id: trade.id, market: trade.conditionId, asset_id: trade.assetId,
        side: trade.side as Side, size: trade.size, price: trade.price,
        status: trade.status, match_time: String(Date.parse(trade.matchedAt) / 1000),
      })),
      next_cursor: page.nextCursor ?? "LTE=",
    };
  }

  async getBalanceAllowance({ asset_type, token_id }: { asset_type: AssetType; token_id?: string }) {
    return fetchBalanceAllowance(this.authenticated(), { assetType: asset_type, assetId: token_id });
  }

  async createOrder({ tokenID, price, size, side }: { tokenID: string; price: number; size: number; side: Side }): Promise<SignedOrder> {
    return this.authenticated().createLimitOrder({ assetId: tokenID, price, size, side, postOnly: this.postOnly });
  }

  async postOrder(order: SignedOrder): Promise<OrderResponse> {
    const response = await this.authenticated().postOrder(order);
    return response.ok ? {
      success: true, errorMsg: "", orderID: response.orderId, status: response.status,
      makingAmount: response.makingAmount, takingAmount: response.takingAmount,
      transactionsHashes: response.transactionsHashes,
    } : {
      success: false, errorMsg: response.message, orderID: "", status: "",
      makingAmount: "0", takingAmount: "0", transactionsHashes: [],
    };
  }

  async cancelOrders(orderIds: string[]) {
    const response = await this.authenticated().cancelOrders({ orderIds });
    return { canceled: response.canceled, not_canceled: Object.keys(response.notCanceled) };
  }
}

function options(config: Config) {
  if (config.chainId !== undefined && config.chainId !== 137) {
    throw new Error("The unified Kuest SDK has only a verified Polygon Mainnet environment");
  }
  return {
    environment: forkEnvironmentConfig({
      name: "market-maker", clob: { rest: config.clobHost },
      relayer: { rest: config.relayerHost ?? "https://relayer.kuest.com" },
      gamma: { rest: config.gammaHost ?? "https://gamma-api.kuest.com" },
      data: { rest: config.dataHost ?? "https://data-api.kuest.com" },
      rpc: config.rpcUrl ?? "https://polygon.drpc.org",
    }),
    siteConfig: loadSiteConfig(),
  };
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
