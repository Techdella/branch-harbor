/**
 * Form builder (Marketing workspace → forms & landing pages). A form is usable as a website section and as a
 * standalone landing page; submissions become leads routed to a location, with explicit consent checkboxes.
 */
import { z } from 'zod';
import { isSafeImage } from './site-document.ts';

export const FORM_FIELD_TYPES = ['text', 'email', 'phone', 'textarea', 'select', 'checkbox', 'date', 'number', 'location'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const formFieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  type: z.enum(FORM_FIELD_TYPES),
  label: z.string().min(1).max(120),
  help: z.string().max(240).default(''),
  required: z.boolean().default(false),
  /** select options (one per entry). */
  options: z.array(z.string().min(1).max(80)).max(30).default([]),
  /** Maps the answer onto the lead: name / email / phone / message. */
  maps: z.enum(['none', 'name', 'email', 'phone', 'message']).default('none'),
});
export type FormField = z.infer<typeof formFieldSchema>;

export const formConsentSchema = z.object({
  purpose: z.enum(['marketing_email', 'marketing_sms', 'marketing_whatsapp']),
  label: z.string().min(1).max(300),
  /** Version recorded with the consent (change it when the wording changes). */
  version: z.string().min(1).max(20).default('1'),
});

export const formSettingsSchema = z.object({
  submitLabel: z.string().max(40).default(''),
  successMessage: z.string().max(400).default(''),
  /** Where leads go: the form's location, or the location the visitor picks (needs a `location` field). */
  routing: z.enum(['form_location', 'visitor_choice']).default('form_location'),
  notifyEmails: z.array(z.email()).max(10).default([]),
  consents: z.array(formConsentSchema).max(3).default([]),
  /** Standalone landing page. */
  landing: z.object({ enabled: z.boolean().default(false), heading: z.string().max(140).default(''), intro: z.string().max(1000).default(''), image: z.string().max(2048).refine((v) => !v || isSafeImage(v), 'Use an https image').default('') }).default({ enabled: false, heading: '', intro: '', image: '' }),
  /** Tag added to the contact (automations can start from it). */
  tag: z.string().max(40).default(''),
});
export type FormSettings = z.infer<typeof formSettingsSchema>;

export const formDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  fields: z.array(formFieldSchema).min(1).max(30),
  settings: formSettingsSchema.default(formSettingsSchema.parse({})),
});
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

/** Validate a visitor's answers against the form. Returns field → error code. */
export function validateSubmission(fields: FormField[], data: Record<string, unknown>, allowedLocationIds: string[] = []): { ok: boolean; errors: Record<string, 'required' | 'invalid'>; values: Record<string, string | boolean> } {
  const errors: Record<string, 'required' | 'invalid'> = {};
  const values: Record<string, string | boolean> = {};
  for (const f of fields) {
    const raw = data[f.id];
    if (f.type === 'checkbox') {
      const v = raw === true || raw === 'true' || raw === 'on';
      if (f.required && !v) errors[f.id] = 'required';
      values[f.id] = v;
      continue;
    }
    const v = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    if (!v) { if (f.required) errors[f.id] = 'required'; continue; }
    if (v.length > (f.type === 'textarea' ? 4000 : 300)) { errors[f.id] = 'invalid'; continue; }
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors[f.id] = 'invalid';
    else if (f.type === 'phone' && !/^\+?[0-9 ().-]{5,30}$/.test(v)) errors[f.id] = 'invalid';
    else if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) errors[f.id] = 'invalid';
    else if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.id] = 'invalid';
    else if (f.type === 'select' && !f.options.includes(v)) errors[f.id] = 'invalid';
    else if (f.type === 'location' && !allowedLocationIds.includes(v)) errors[f.id] = 'invalid';
    values[f.id] = v;
  }
  return { ok: Object.keys(errors).length === 0, errors, values };
}
