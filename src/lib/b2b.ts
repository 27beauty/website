import type { Env } from '../types';

/** Wholesale/trade enquiry form on /b2b — stored for the owner to action from admin. */
export interface B2bInquiryInput {
  businessName: string;
  contactName: string;
  email: string;
  phone: string | null;
  message: string | null;
}

export async function createB2bInquiry(env: Env, input: B2bInquiryInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO b2b_inquiries (business_name, contact_name, email, phone, message) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(input.businessName, input.contactName, input.email, input.phone || null, input.message || null)
    .run();
}
