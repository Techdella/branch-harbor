import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

/** Builds page metadata from a namespace with `metaTitle` and an optional description key. */
export async function pageMetadata(locale: string, namespace: string, descriptionKey = 'intro'): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace });
  return { title: t('metaTitle'), description: t.has(descriptionKey) ? t(descriptionKey) : undefined };
}
