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
  /** eBay "RuName" for the seller consent redirect (developer portal → User Tokens). Not secret. */
  EBAY_RUNAME?: string;
  /** Amazon SP-API (Login with Amazon) app credentials and the seller's self-authorised refresh token. */
  AMAZON_LWA_CLIENT_ID?: string;
  AMAZON_LWA_CLIENT_SECRET?: string;
  AMAZON_REFRESH_TOKEN?: string;
  /** Seller Central "Merchant Token". */
  AMAZON_SELLER_ID?: string;
}

/** Hono context variables set by middleware in src/index.ts. */
export type Variables = {
  admin?: AdminSession;
  cartCount: number;
  /** Extra detail a storefront route adds to its analytics page view (src/lib/analytics.ts). */
  track?: TrackDetail;
};

export interface TrackDetail {
  productId?: number;
  searchTerm?: string;
  searchResults?: number;
  campaign?: string;
}

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
  ebay_sku: string | null;
  ebay_account: string | null;
  ebay_url: string | null;
  ebay_synced_at: string | null;
  /** Quantity eBay reported at the last sync — null until a sync has run. */
  ebay_stock: number | null;
  price_locked: number;
  stock_locked: number;
  content_locked: number;
  /** Parcel size for shipping; null = use the default from Settings. */
  /** Set when this product was folded into another (same item in both eBay shops). */
  merged_into: number | null;
  weight_g: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
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
  /**
   * The product this coupon was made for. By default it only decides what the
   * QR landing page features — the discount itself applies to the whole
   * basket. Set `product_only` to restrict the discount to this product.
   */
  product_id: number | null;
  /** 1 = discount only this product's lines; 0 = discount the whole basket. */
  product_only: number;
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
  /** pushed (legacy unpaid draft) | booking | booked | error */
  parcel2go_status: string | null;
  parcel2go_error: string | null;
  parcel2go_hash: string | null;
  parcel2go_service: string | null;
  parcel2go_courier: string | null;
  parcel2go_price_pence: number | null;
  parcel2go_booked_at: string | null;
  recovery_url: string | null;
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

export interface B2bInquiry {
  id: number;
  business_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  message: string | null;
  status: 'new' | 'read' | 'archived';
  created_at: string;
}

export type SalesChannel = 'ebay' | 'amazon';

export interface ChannelListing {
  id: number;
  product_id: number | null;
  channel: SalesChannel;
  account: string;
  external_id: string;
  sku: string | null;
  asin: string | null;
  title: string;
  /** merchant = you ship it; amazon = FBA, never pushed to or counted. */
  fulfilment: 'merchant' | 'amazon';
  status: 'linked' | 'review' | 'ignored';
  match_score: number | null;
  suggested_product_id: number | null;
  channel_qty: number | null;
  pushed_qty: number | null;
  pushed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type StockReason = 'website_sale' | 'ebay_sale' | 'amazon_sale' | 'cancel' | 'admin' | 'start' | 'merge';

export interface StockMovement {
  id: number;
  product_id: number;
  delta: number;
  stock_after: number | null;
  reason: StockReason;
  ref: string;
  note: string | null;
  created_at: string;
}

export interface EbayAccount {
  id: number;
  label: string;
  seller_username: string | null;
  mode: 'browse' | 'sell';
  refresh_token_var: string | null;
  /** Seller consent from the admin "Connect" button, AES-GCM encrypted (src/lib/crypto.ts). */
  refresh_token_enc: string | null;
  connected_at: string | null;
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
