import { Hono } from 'hono';
import type { AppBindings } from '../../types';

/** Admin panel: auth, dashboard, products, orders, coupons, settings, sync. */
export const admin = new Hono<AppBindings>();
