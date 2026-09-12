import { Hono } from 'hono';
import type { AppBindings } from '../types';

/** Public shop pages: home, category, product, search, cart, static pages. */
export const storefront = new Hono<AppBindings>();
