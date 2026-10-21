import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";

const mocks = vi.hoisted(() => ({
  publicClient: {} as Record<string, unknown>,
  secureClient: {} as Record<string, unknown>,
  createPublicClient: vi.fn(),
  createSecureClient: vi.fn(),
  fetchBalanceAllowance: vi.fn(),
  isWalletDeployed: vi.fn(),
  signer: vi.fn(),
  siteConfig: { builder_code: "0x00", site_url: "" },
}));

vi.mock("@kuest/sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@kuest/sdk")>();
  return {
    ...original,
    createPublicClient: mocks.createPublicClient,
    createSecureClient: mocks.createSecureClient,
  };
});
vi.mock("@kuest/sdk/actions", () => ({
  fetchBalanceAllowance: mocks.fetchBalanceAllowance,
  isWalletDeployed: mocks.isWalletDeployed,
}));
vi.mock("@kuest/sdk/node", () => ({ loadSiteConfig: () => mocks.siteConfig }));
vi.mock("@kuest/sdk/viem", () => ({ privateKey: mocks.signer }));

import { UnifiedMarketClient } from "../../src/sdk-adapter.js";

const config = (): Config => ({
  clobHost: "https://clob.example", relayerHost: "https://relayer.example",
  gammaHost: "https://gamma.example", dataHost: "https://data.example",
  rpcUrl: "https://rpc.example", chainId: 137, live: false,
  discovery: "site", maxMarkets: 1, maxPages: 1, orderSize: 1,
  edgeTicks: 1, minSpreadTicks: 1, maxBookSpreadTicks: 10,
  minTopDepth: 1, quoteSides: "buy", allowSingleSided: true,
  respectRewardMinSize: false, cancelBeforeQuote: false, cancelAll: false,
  cancelAllOnExit: false, cancelOnRiskBreach: false, pauseOnRiskBreach: false,
  clearPause: false, pausePath: "state/pause", postOnly: true,
  requireTwoSidedLive: false, maxPrePostMoveTicks: 1, maxDataAgeSecs: 10,
  minPrice: 0.01, maxPrice: 0.99, maxCollateralPerMarket: 10,
  maxLossPerMarket: 10, maxInventoryPerToken: 10,
  maxInventoryPerMarket: 10, maxTotalCollateral: 10,
  minFreeCollateral: 0, maxOpenOrdersPerToken: 1,
  discoverOnly: false, cycles: 1, refreshSecs: 1, statePath: "state/seen",
  fillStatePath: "state/fills", fillMaxRecords: 10,
  positionReconcileTolerance: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.publicClient = {};
  mocks.secureClient = {};
  mocks.createPublicClient.mockImplementation(() => mocks.publicClient);
  mocks.createSecureClient.mockImplementation(async () => mocks.secureClient);
  mocks.isWalletDeployed.mockResolvedValue(true);
  mocks.siteConfig = { builder_code: "0x00", site_url: "" };
  vi.unstubAllGlobals();
});

describe("unified SDK boundary", () => {
  it("uses explicit approved service endpoints and the operator site overlay", () => {
    UnifiedMarketClient.public(config());
    expect(mocks.createPublicClient).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({
        clob: expect.objectContaining({ rest: "https://clob.example" }),
        gamma: expect.objectContaining({ rest: "https://gamma.example" }),
        relayer: expect.objectContaining({ rest: "https://relayer.example" }),
        data: expect.objectContaining({ rest: "https://data.example" }),
        rpc: "https://rpc.example",
      }),
      siteConfig: { builder_code: "0x00", site_url: "" },
    }));
    expect(() => UnifiedMarketClient.public({ ...config(), chainId: 80002 })).toThrow(/Polygon Mainnet/);
  });

  it("uses the verified CLOB pagination route because Gamma keyset is unavailable", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [], next_cursor: "next", count: 0, limit: 50,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const page = await UnifiedMarketClient.public(config()).getMarkets();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toBe("https://clob.example/markets?next_cursor=MA%3D%3D");
    expect(page.next_cursor).toBe("next");
  });

  it("keeps operator site scope when reading raw CLOB market pages", async () => {
    mocks.siteConfig.site_url = "operator.example";
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        slug: "event", markets: [{ condition_id: "allowed", enable_order_book: true }],
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ condition_id: "other" }, { condition_id: "allowed" }],
        next_cursor: "LTE=", count: 2, limit: 50,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = UnifiedMarketClient.public(config());
    expect((await client.getMarkets()).data).toEqual([{ condition_id: "allowed" }]);
    expect(String(fetch.mock.calls[0][0])).toContain("operator.example/api/events");
    expect(String(fetch.mock.calls[1][0])).toContain("clob.example/markets");
    expect(await client.getMarket("other")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("signs post-only orders through the SDK and adapts cancellation failures", async () => {
    const signed = { salt: "1", signature: "0x" };
    const createLimitOrder = vi.fn().mockResolvedValue(signed);
    const cancelOrders = vi.fn().mockResolvedValue({
      canceled: ["one"], notCanceled: { two: "not found" },
    });
    mocks.secureClient.createLimitOrder = createLimitOrder;
    mocks.secureClient.cancelOrders = cancelOrders;
    const secure = await UnifiedMarketClient.secure({
      ...config(), live: true, privateKey: "private-test-only",
      depositWallet: "0x0000000000000000000000000000000000000001",
    });
    expect(mocks.createSecureClient).toHaveBeenCalledWith(expect.objectContaining({
      siteConfig: { builder_code: "0x00", site_url: "" },
      wallet: "0x0000000000000000000000000000000000000001",
    }));
    expect(await secure.createOrder({ tokenID: "123", price: 0.5, size: 3, side: "BUY" as never })).toBe(signed);
    expect(createLimitOrder).toHaveBeenCalledWith({
      assetId: "123", price: 0.5, size: 3, side: "BUY", postOnly: true,
    });
    expect(await secure.cancelOrders(["one", "two"])).toEqual({ canceled: ["one"], not_canceled: ["two"] });
  });

  it("rejects undeployed wallets before SDK authentication can deploy one", async () => {
    mocks.isWalletDeployed.mockResolvedValue(false);
    await expect(UnifiedMarketClient.secure({
      ...config(), live: true, privateKey: "private-test-only",
      depositWallet: "0x0000000000000000000000000000000000000001",
    })).rejects.toThrow(/will not deploy/);
    expect(mocks.createSecureClient).not.toHaveBeenCalled();
  });
});
