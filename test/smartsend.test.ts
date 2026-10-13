/** The Parcel2Go Smart Send spreadsheet: one row per paid order, in the columns Smart Send maps. */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import {
  ITEM_NAME_MAX,
  SMART_SEND_COLUMNS,
  confirmSentToSmartSend,
  countNewForSmartSend,
  itemSummary,
  listUnconfirmedForSmartSend,
  markDownloadedForSmartSend,
  ordersForSmartSend,
  smartSendCsv,
  toCsv,
  toIso2Country,
} from '../src/lib/smartsend';
import { createTestD1 } from './helpers/d1';

let env: Env;
let sql: ReturnType<typeof createTestD1>;

beforeEach(() => {
  sql = createTestD1();
  env = { DB: sql.db } as unknown as Env;
  sql.exec(`
    INSERT INTO products (id, slug, title, price_pence, stock, weight_g, length_cm, width_cm, height_cm) VALUES
      (1, 'cream', 'Hand Cream 50ml', 500, 9, 200, 10, 5, 5);
    INSERT INTO orders (id, order_number, status, email, customer_name, phone, subtotal_pence, discount_pence, shipping_pence, total_pence, shipping_json)
    VALUES
      (1, '27B-1001', 'paid', 'ann@example.com', 'Ann Smith', '07700900000', 1500, 150, 0, 1350,
       '{"line1":"12 High Street","line2":"Flat 2","city":"Blackburn","postcode":"BB1 1AA","country":"GB"}'),
      (2, '27B-1002', 'fulfilled', 'bo@example.com', 'Bo', NULL, 500, 0, 0, 500, '{"line1":"1 Road","city":"Leeds","postcode":"LS1 1AA","country":"GB"}');
    INSERT INTO order_items (order_id, product_id, title, unit_price_pence, quantity, line_total_pence) VALUES
      (1, 1, 'Hand Cream 50ml', 500, 3, 1500);
  `);
});

describe('Smart Send CSV', () => {
  it('has one row per paid order, in the columns Smart Send expects', async () => {
    const orders = await ordersForSmartSend(env, 'new');
    expect(orders.map((o) => o.order_number)).toEqual(['27B-1001']);
    const lines = (await smartSendCsv(env, orders)).trim().split('\r\n');
    expect(lines[0]).toBe(SMART_SEND_COLUMNS.map((c) => `"${c}"`).join(','));
    const row = lines[1].slice(1, -1).split('","');
    const cell = (name: string) => row[SMART_SEND_COLUMNS.indexOf(name as (typeof SMART_SEND_COLUMNS)[number])];
    expect(cell('Reference')).toBe('27B-1001');
    expect(cell('Item Name')).toBe('3 x Hand Cream 50ml');
    expect(cell('Value')).toBe('13.50'); // goods after discount, no £
    expect(cell('Weight')).toBe('0.6'); // 3 × 200g, in kg
    expect(cell('Property')).toBe('12');
    expect(cell('Street')).toBe('High Street, Flat 2');
    expect(cell('Town')).toBe('Blackburn');
    expect(cell('Postcode')).toBe('BB1 1AA');
    expect(cell('Country')).toBe('GB');
    expect(cell('Name')).toBe('Ann Smith');
  });

  it("keeps a downloaded order waiting until the upload is confirmed", async () => {
    expect(await countNewForSmartSend(env)).toBe(1);
    await markDownloadedForSmartSend(env, [1]);
    // Downloaded: not offered as new again, but not lost either.
    expect(await countNewForSmartSend(env)).toBe(0);
    expect(await ordersForSmartSend(env, 'new')).toEqual([]);
    expect((await ordersForSmartSend(env, 'unconfirmed')).map((o) => o.id)).toEqual([1]);
    expect((await listUnconfirmedForSmartSend(env)).map((o) => o.order_number)).toEqual(['27B-1001']);

    expect(await confirmSentToSmartSend(env, [1])).toBe(1);
    expect(await listUnconfirmedForSmartSend(env)).toEqual([]);
    expect(await ordersForSmartSend(env, 'unconfirmed')).toEqual([]);
    expect((await ordersForSmartSend(env, 'all')).map((o) => o.id)).toEqual([1]);
  });

  it("can't confirm an order that was never downloaded", async () => {
    expect(await confirmSentToSmartSend(env, [1])).toBe(0);
    expect(await countNewForSmartSend(env)).toBe(1);
  });

  it('only confirms the orders the owner saw, not one downloaded since', async () => {
    sql.exec(`
      INSERT INTO orders (id, order_number, status, subtotal_pence, discount_pence, shipping_pence, total_pence)
      VALUES (3, '27B-1003', 'paid', 500, 0, 0, 500);
    `);
    await markDownloadedForSmartSend(env, [1]);
    await markDownloadedForSmartSend(env, [3]); // a second download in another tab
    expect(await confirmSentToSmartSend(env, [1])).toBe(1);
    expect((await listUnconfirmedForSmartSend(env)).map((o) => o.id)).toEqual([3]);
  });

  it('quotes commas and quotes safely, and writes UK as GB', () => {
    expect(toCsv([['a, b', 'say "hi"']])).toBe('"a, b","say ""hi"""\r\n');
    expect(toIso2Country('United Kingdom'.slice(0, 0))).toBe('GB');
    expect(toIso2Country('GBR')).toBe('GB');
    expect(toIso2Country('ie')).toBe('IE');
  });
});

describe('itemSummary', () => {
  const line = (quantity: number, title: string) => ({ quantity, title });

  it('lists every line in full when it fits', () => {
    expect(itemSummary([line(3, 'Hand Cream 50ml'), line(1, 'Lip Oil')], '27B-1')).toBe('3 x Hand Cream 50ml; 1 x Lip Oil');
  });

  it('shortens long titles, never drops a line, and keeps short titles whole', () => {
    const long = 'NYX Professional Makeup Lip Lingerie XXL Matte Liquid Lipstick - Warm Up, long lasting, vegan formula';
    const items = [line(1, long), line(2, long.replace('Warm Up', 'Sizzlin')), line(1, 'Lip Oil'), line(4, long.replace('Warm Up', 'Bust Ed'))];
    const out = itemSummary(items, '27B-1');
    expect(out.length).toBeLessThanOrEqual(ITEM_NAME_MAX);
    const parts = out.split('; ');
    expect(parts).toHaveLength(4);
    expect(parts.map((p) => p.split(' x ')[0])).toEqual(['1', '2', '1', '4']);
    expect(parts[2]).toBe('1 x Lip Oil');
    expect(out).not.toContain('more');
  });

  it('says how many lines are left out, and where to find them, when even short titles cannot fit', () => {
    const items = Array.from({ length: 30 }, (_, i) => line(1, `Product number ${i + 1} with a long name`));
    const out = itemSummary(items, '27B-1042');
    expect(out.length).toBeLessThanOrEqual(ITEM_NAME_MAX);
    const m = /; \+(\d+) more, see 27B-1042$/.exec(out);
    expect(m).not.toBeNull();
    const shown = out.slice(0, m!.index).split('; ').length;
    expect(shown + Number(m![1])).toBe(30);
  });
});
