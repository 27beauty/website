import { describe, expect, it } from 'vitest';
import { buildReviseInventoryStatus, parseActiveList, parseItemDetails, parseItemStatus, parseReviseResponse, tagText } from '../src/lib/ebay/trading';
import { saleLines } from '../src/lib/ebay/orders';
import { classifyOrders, mapListing, mapListingDetails } from '../src/lib/amazon/spapi';
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
      { orderId: 'A', lineItemId: '1', itemId: '111', quantity: 2, title: 'x', cancelled: false, placedAt: null, lastModified: null },
      { orderId: 'B', lineItemId: '2', itemId: '222', quantity: 1, title: '', cancelled: true, placedAt: null, lastModified: null },
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
    ).toEqual({ sold: ['1', '2'], cancelled: ['3'], placedBefore: [] });
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

describe('eBay account-deletion challenge', () => {
  it("matches eBay's documented formula: hex SHA-256 of code + token + endpoint", async () => {
    const { challengeResponse } = await import('../src/lib/ebay/deletion');
    const r = await challengeResponse('abc', 'token', 'https://x.test/e');
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abctokenhttps://x.test/e')))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(r).toBe(expected);
    expect(r).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('orders placed before counting started', () => {
  it('eBay: skips sales placed before the cutoff, but still reports cancellations', () => {
    const orders = [
      { orderId: 'A', creationDate: '2026-01-01T00:00:00Z', lastModifiedDate: '2026-02-01T00:00:00Z', lineItems: [{ lineItemId: '1', legacyItemId: '9', quantity: 1 }] },
      { orderId: 'B', creationDate: '2026-03-01T00:00:00Z', lineItems: [{ lineItemId: '2', legacyItemId: '9', quantity: 2 }] },
      { orderId: 'C', creationDate: '2026-01-01T00:00:00Z', cancelStatus: { cancelState: 'CANCELED' }, lineItems: [{ lineItemId: '3', legacyItemId: '9', quantity: 1 }] },
    ];
    expect(saleLines(orders, '2026-02-01T00:00:00Z').map((l) => l.orderId)).toEqual(['B', 'C']);
    expect(saleLines(orders).map((l) => l.orderId)).toEqual(['A', 'B', 'C']);
  });

  it('Amazon: separates orders placed before the cutoff from new sales', () => {
    const r = classifyOrders(
      [
        { AmazonOrderId: 'old', OrderStatus: 'Shipped', FulfillmentChannel: 'MFN', PurchaseDate: '2026-01-01T00:00:00Z' },
        { AmazonOrderId: 'new', OrderStatus: 'Unshipped', FulfillmentChannel: 'MFN', PurchaseDate: '2026-03-01T00:00:00Z' },
        { AmazonOrderId: 'gone', OrderStatus: 'Canceled', FulfillmentChannel: 'MFN', PurchaseDate: '2026-01-01T00:00:00Z' },
      ],
      '2026-02-01T00:00:00Z',
    );
    expect(r).toEqual({ sold: ['new'], cancelled: ['gone'], placedBefore: ['old'] });
  });
});

describe('eBay listing status (GetItem)', () => {
  const xml = (status: string, qty = 5, sold = 2) =>
    `<GetItemResponse><Ack>Success</Ack><Item><Quantity>${qty}</Quantity><SellingStatus><QuantitySold>${sold}</QuantitySold><ListingStatus>${status}</ListingStatus></SellingStatus></Item></GetItemResponse>`;
  it('treats an Active listing as live even when it has sold out', () => {
    expect(parseItemStatus(xml('Active'))).toEqual({ state: 'live', quantityAvailable: 3 });
    expect(parseItemStatus(xml('Active', 4, 4))).toEqual({ state: 'live', quantityAvailable: 0 });
  });
  it('treats Completed or Ended, or an item eBay no longer has, as ended', () => {
    expect(parseItemStatus(xml('Completed')).state).toBe('ended');
    expect(parseItemStatus(xml('Ended')).state).toBe('ended');
    expect(parseItemStatus('<GetItemResponse><Ack>Failure</Ack><Errors><ErrorCode>17</ErrorCode><SeverityCode>Error</SeverityCode><LongMessage>Item cannot be accessed.</LongMessage></Errors></GetItemResponse>').state).toBe('ended');
  });
  it('is unsure about anything else', () => {
    expect(parseItemStatus('<GetItemResponse><Ack>Failure</Ack></GetItemResponse>').state).toBe('unknown');
  });
});

describe('ReviseInventoryStatus: quantity already set', () => {
  it("counts a listing eBay didn't change because it already shows that quantity as done", () => {
    const xml = `<ReviseInventoryStatusResponse><Ack>Warning</Ack>
      <Errors><ErrorCode>21917092</ErrorCode><SeverityCode>Warning</SeverityCode><LongMessage>The existing quantity value is identical to the quantity specified in the request and, therefore, has not modified.</LongMessage></Errors>
      <InventoryStatus><ItemID>2</ItemID><Quantity>4</Quantity></InventoryStatus>
    </ReviseInventoryStatusResponse>`;
    const r = parseReviseResponse(xml, [{ itemId: '1', quantity: 3 }, { itemId: '2', quantity: 4 }]);
    expect([...r.ok].sort()).toEqual(['1', '2']);
    expect(r.failed.size).toBe(0);
  });

  it('still reports a real error', () => {
    const xml = `<ReviseInventoryStatusResponse><Ack>Failure</Ack><Errors><ErrorCode>21919188</ErrorCode><SeverityCode>Error</SeverityCode><LongMessage>Listing 1 has ended.</LongMessage></Errors></ReviseInventoryStatusResponse>`;
    expect(parseReviseResponse(xml, [{ itemId: '1', quantity: 3 }]).failed.get('1')).toMatch(/has ended/);
  });
});

describe('Amazon listing details', () => {
  it('reads the UK price, main photo and description', () => {
    expect(
      mapListingDetails({
        summaries: [{ marketplaceId: 'A1F83G8C2ARO7P', mainImage: { link: 'https://m.media-amazon.com/x.jpg' } }],
        offers: [
          { marketplaceId: 'A1PA6795UKMFR9', offerType: 'B2C', price: { currencyCode: 'EUR', amount: '11.00' } },
          { marketplaceId: 'A1F83G8C2ARO7P', offerType: 'B2C', price: { currencyCode: 'GBP', amount: '9.5' } },
        ],
        attributes: { bullet_point: [{ value: 'Vegan', marketplace_id: 'A1F83G8C2ARO7P' }, { value: 'Made in UK', marketplace_id: 'A1F83G8C2ARO7P' }] },
      }),
    ).toEqual({ pricePence: 950, imageUrl: 'https://m.media-amazon.com/x.jpg', description: '• Vegan\n• Made in UK' });
  });

  it('copes with a listing that has none of them', () => {
    expect(mapListingDetails({})).toEqual({ pricePence: null, imageUrl: null, description: null });
  });
});

describe('eBay listing details (GetItem)', () => {
  it('reads the price, photos and description', () => {
    const xml = `<GetItemResponse><Ack>Success</Ack><Item>
      <SellingStatus><CurrentPrice currencyID="GBP">12.49</CurrentPrice><ListingStatus>Active</ListingStatus></SellingStatus>
      <PictureDetails><PictureURL>https://i.ebayimg.com/a.jpg</PictureURL><PictureURL>https://i.ebayimg.com/b.jpg</PictureURL></PictureDetails>
      <Description>&lt;p&gt;Daily vitamins&lt;/p&gt;</Description>
    </Item></GetItemResponse>`;
    expect(parseItemDetails(xml)).toEqual({
      pricePence: 1249,
      images: ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'],
      description: 'Daily vitamins',
    });
  });

  it('ignores a price in another currency', () => {
    expect(parseItemDetails('<Item><SellingStatus><CurrentPrice currencyID="EUR">9.00</CurrentPrice></SellingStatus></Item>').pricePence).toBeNull();
  });
});
