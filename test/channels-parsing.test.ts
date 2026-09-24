import { describe, expect, it } from 'vitest';
import { buildReviseInventoryStatus, parseActiveList, parseReviseResponse, tagText } from '../src/lib/ebay/trading';
import { saleLines } from '../src/lib/ebay/orders';
import { classifyOrders, mapListing } from '../src/lib/amazon/spapi';
import { planEbayBatches } from '../src/lib/channels';
import { decryptSecret, encryptSecret } from '../src/lib/crypto';

describe('ReviseInventoryStatus', () => {
  it('builds one InventoryStatus per listing and never sends a negative quantity', () => {
    expect(buildReviseInventoryStatus([{ itemId: '111', quantity: 3 }, { itemId: '222', quantity: -2 }])).toBe(
      '<InventoryStatus><ItemID>111</ItemID><Quantity>3</Quantity></InventoryStatus><InventoryStatus><ItemID>222</ItemID><Quantity>0</Quantity></InventoryStatus>',
    );
  });

  it('refuses more than eBay allows in one call', () => {
    expect(() => buildReviseInventoryStatus(Array.from({ length: 5 }, (_, i) => ({ itemId: String(i), quantity: 1 })))).toThrow();
  });

  it('escapes anything XML-significant', () => {
    expect(buildReviseInventoryStatus([{ itemId: '1<2', quantity: 1 }])).toContain('<ItemID>1&lt;2</ItemID>');
  });

  it('reports which listings failed in a partly successful call', () => {
    const xml = `<ReviseInventoryStatusResponse><Ack>Warning</Ack>
      <Errors><ShortMessage>Bad</ShortMessage><LongMessage>Item 222 is a multi-variation listing; SKU required.</LongMessage><SeverityCode>Error</SeverityCode></Errors>
      <InventoryStatus><ItemID>111</ItemID><Quantity>3</Quantity></InventoryStatus></ReviseInventoryStatusResponse>`;
    const r = parseReviseResponse(xml, [{ itemId: '111', quantity: 3 }, { itemId: '222', quantity: 3 }]);
    expect([...r.ok]).toEqual(['111']);
    expect(r.failed.get('222')).toContain('multi-variation');
  });
});

describe('GetMyeBaySelling', () => {
  it('reads exact available quantities, falling back to quantity minus sold', () => {
    const xml = `<GetMyeBaySellingResponse><ActiveList><ItemArray>
      <Item><ItemID>111</ItemID><Title>Tea &amp; Biscuits</Title><SKU>TB-1</SKU><Quantity>10</Quantity><QuantityAvailable>4</QuantityAvailable><SellingStatus><QuantitySold>6</QuantitySold></SellingStatus></Item>
      <Item><ItemID>222</ItemID><Title>Shampoo</Title><Quantity>5</Quantity><SellingStatus><QuantitySold>2</QuantitySold></SellingStatus><Variations><Variation/></Variations></Item>
      </ItemArray><PaginationResult><TotalNumberOfPages>3</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>`;
    expect(parseActiveList(xml)).toEqual({
      totalPages: 3,
      listings: [
        { itemId: '111', title: 'Tea & Biscuits', sku: 'TB-1', quantityAvailable: 4, hasVariations: false },
        { itemId: '222', title: 'Shampoo', sku: null, quantityAvailable: 3, hasVariations: true },
      ],
    });
  });

  it('does not confuse <User> with <UserID>', () => {
    expect(tagText('<GetUserResponse><User><UserID>adinath0</UserID></User></GetUserResponse>', 'UserID')).toBe('adinath0');
  });
});

describe('eBay orders', () => {
  it('turns orders into sale lines, flags cancellations and skips failed payments', () => {
    const lines = saleLines([
      { orderId: 'A', orderPaymentStatus: 'PAID', lineItems: [{ lineItemId: '1', legacyItemId: '111', quantity: 2, title: 'x' }] },
      { orderId: 'B', orderPaymentStatus: 'PAID', cancelStatus: { cancelState: 'CANCELED' }, lineItems: [{ lineItemId: '2', legacyItemId: '222', quantity: 1 }] },
      { orderId: 'C', orderPaymentStatus: 'FAILED', lineItems: [{ lineItemId: '3', legacyItemId: '333', quantity: 1 }] },
      { orderId: 'D', lineItems: [{ lineItemId: '4', quantity: 1 }] },
    ]);
    expect(lines).toEqual([
      { orderId: 'A', lineItemId: '1', itemId: '111', quantity: 2, title: 'x', cancelled: false },
      { orderId: 'B', lineItemId: '2', itemId: '222', quantity: 1, title: '', cancelled: true },
    ]);
  });
});

describe('Amazon', () => {
  it('tells listings you ship (FBM) from ones Amazon ships (FBA)', () => {
    expect(mapListing({ sku: 'A', summaries: [{ itemName: 'Tea' }], fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 3 }] })).toMatchObject({
      fulfilment: 'merchant',
      quantity: 3,
    });
    expect(mapListing({ sku: 'B', summaries: [{ itemName: 'Tea' }], fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_EU', quantity: 30 }] })).toMatchObject({
      fulfilment: 'amazon',
      quantity: null,
    });
    expect(mapListing({ summaries: [] })).toBeNull();
  });

  it('counts own-shipped orders from Pending on, and separates cancellations', () => {
    expect(
      classifyOrders([
        { AmazonOrderId: '1', OrderStatus: 'Pending', FulfillmentChannel: 'MFN' },
        { AmazonOrderId: '2', OrderStatus: 'Shipped', FulfillmentChannel: 'MFN' },
        { AmazonOrderId: '3', OrderStatus: 'Canceled', FulfillmentChannel: 'MFN' },
        { AmazonOrderId: '4', OrderStatus: 'Shipped', FulfillmentChannel: 'AFN' },
        { AmazonOrderId: '5', OrderStatus: 'Unfulfillable', FulfillmentChannel: 'MFN' },
      ]),
    ).toEqual({ sold: ['1', '2'], cancelled: ['3'] });
  });
});

describe('planEbayBatches', () => {
  it('groups listings per shop, four to a request', () => {
    const l = (id: number, account: string) => ({ id, channel: 'ebay' as const, account, external_id: String(id), stock: 1 });
    const plan = planEbayBatches([l(1, 'a'), l(2, 'a'), l(3, 'b'), l(4, 'a'), l(5, 'a'), l(6, 'a'), { ...l(7, 'x'), channel: 'amazon' as const }]);
    expect([...plan.keys()]).toEqual(['a', 'b']);
    expect(plan.get('a')?.map((b) => b.map((x) => x.id))).toEqual([[1, 2, 4, 5], [6]]);
  });
});

describe('stored eBay tokens', () => {
  it('round-trips, and fails closed under the wrong key or if tampered with', async () => {
    const enc = await encryptSecret('v^1.1#i^1#refresh', 'key-one-0123456789');
    expect(enc).not.toContain('refresh');
    expect(await decryptSecret(enc, 'key-one-0123456789')).toBe('v^1.1#i^1#refresh');
    expect(await decryptSecret(enc, 'key-two-0123456789')).toBeNull();
    expect(await decryptSecret(`${enc.slice(0, -2)}AA`, 'key-one-0123456789')).toBeNull();
  });
});
