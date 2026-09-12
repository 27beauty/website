import { Hono } from 'hono';
import type { AppBindings } from '../types';

/** Inbound webhooks (Stripe). Mounted before any body-parsing middleware. */
export const webhooks = new Hono<AppBindings>();
