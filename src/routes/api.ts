import { Hono } from 'hono';
import type { AppBindings } from '../types';

/** Machine endpoints: eBay sync trigger, health check, product JSON feed. */
export const api = new Hono<AppBindings>();
