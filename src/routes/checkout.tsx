import { Hono } from 'hono';
import type { AppBindings } from '../types';

/** Checkout flow: details form, Stripe Checkout redirect, success/cancel pages. */
export const checkout = new Hono<AppBindings>();
