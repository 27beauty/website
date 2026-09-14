/**
 * Shared types for the 27beauty Worker.
 * Every module in src/ imports its bindings and row shapes from here.
 */

export interface Env {
  // Bindings (wrangler.toml)
  DB: D1Database;
  KV: KVNamespace;
  /** Optional: only bound once R2 is enabled on the account (see wrangler.toml). */
  MEDIA?: R2Bucket;
  ASSETS: Fetcher;

  // Plain vars
  SITE_NAME: string;
  SITE_URL: string;
  SUPPORT_EMAIL: string;
  CURRENCY: string;
  FREE_SHIPPING_THRESHOLD_PENCE: string;
  SHIPPING_FLAT_PENCE: string;

  // Secrets (wrangler secret put ... / .dev.vars)
  SESSION_SECRET: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  EBAY_REFRESH_TOKEN?: string;
  EBAY_REFRESH_TOKEN_2?: string;
  SYNC_TOKEN?: string;
  PARCEL2GO_CLIENT_ID?: string;
  PARCEL2GO_CLIENT_SECRET?: string;
}

/** Hono context variables set by middleware in src/index.ts. */
export type Variables = {
  admin?: AdminSession;
  cartCount: number;
};

export type AppBindings = { Bindings: Env; Variables: Variables };

export interface AdminSession {
  userId: number;
  email: string;
  name: string | null;
  role: string;
  issuedAt: number;
}

export type ProductStatus = 'active' | 'draft' | 'archived';
export type ProductSource = 'manual' | 'ebay' | 'csv';

export interface Category {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  emoji: string | null;
  image_url: string | null;
  sort_order: number;
  created_at: string;
}

export interface Product {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  category_id: number | null;
  brand: string | null;
  sku: string | null;
  price_pence: number;
  compare_at_pence: number | null;
  cost_pence: number | null;
  stock: number;
  image_url: string | null;
  images_json: string;
  status: ProductStatus;
  featured: number;
  source: ProductSource;
  ebay_item_id: string | null;
  ebay_account: string | null;
  ebay_url: string | null;
  ebay_synced_at: string | null;
  price_locked: number;
  stock_locked: number;
  content_locked: number;
  created_at: string;
  updated_at: string;
}

/** Product joined with its category name/slug (used by listing pages). */
export interface ProductWithCategory extends Product {
  category_name: string | null;
  category_slug: string | null;
}

export type CouponKind = 'percent' | 'fixed';

export interface Coupon {
  id: number;
  code: string;
  kind: CouponKind;
  value: number;
  description: string | null;
  /** When set, the discount applies only to this product's basket lines. */
  product_id: number | null;
  min_spend_pence: number;
  max_redemptions: number | null;
  times_used: number;
  per_customer_limit: number | null;
  free_shipping: number;
  starts_at: string | null;
  expires_at: string | null;
  active: number;
  batch: string | null;
  created_at: string;
}

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled' | 'refunded';

export interface Order {
  id: number;
  order_number: string;
  status: OrderStatus;
  email: string | null;
  customer_name: string | null;
  phone: string | null;
  subtotal_pence: number;
  discount_pence: number;
  shipping_pence: number;
  total_pence: number;
  coupon_code: string | null;
  currency: string;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  shipping_json: string | null;
  tracking_number: string | null;
  carrier: string | null;
  notes: string | null;
  stock_applied: number;
  parcel2go_order_id: string | null;
  parcel2go_payment_url: string | null;
  parcel2go_status: string | null;
  parcel2go_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number | null;
  title: string;
  sku: string | null;
  image_url: string | null;
  unit_price_pence: number;
  quantity: number;
  line_total_pence: number;
}

export interface EbayAccount {
  id: number;
  label: string;
  seller_username: string | null;
  mode: 'browse' | 'sell';
  refresh_token_var: string | null;
  markup_percent: number;
  default_category_id: number | null;
  auto_publish: number;
  active: number;
  last_sync_at: string | null;
  created_at: string;
}

export interface SyncRun {
  id: number;
  source: string;
  trigger: string;
  status: 'running' | 'ok' | 'error';
  created_count: number;
  updated_count: number;
  ended_count: number;
  message: string | null;
  started_at: string;
  finished_at: string | null;
}

/** One line of the shopper's cart as stored in the signed cookie. */
export interface CartLine {
  id: number;
  q: number;
}

/** A cart line resolved against the catalogue, ready to render. */
export interface CartItem {
  product: Product;
  quantity: number;
  lineTotalPence: number;
  /** Set when the requested quantity exceeded available stock. */
  clamped?: boolean;
}

export interface CartTotals {
  items: CartItem[];
  itemCount: number;
  subtotalPence: number;
  discountPence: number;
  shippingPence: number;
  totalPence: number;
  coupon: Coupon | null;
  /** Human-readable reason a coupon in the cookie was not applied. */
  couponError?: string;
}

export interface ShippingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  postcode?: string;
  country?: string;
}
