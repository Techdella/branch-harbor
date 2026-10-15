import { apiGet } from './api';
import type { Money } from './types';

/** Public courses a brand sells (Training academy → "Sell to the public"). */
export interface PublicCourse {
  slug: string; title: string; summary: string | null; description: string | null; coverUrl: string | null; category: string | null; estimatedMinutes: number | null;
  price: Money | null; seats: number | null; seatsLeft: number | null; startsOn: string | null; scheduleNote: string | null; certificate: boolean; purchasable: boolean; trainers: string[];
  outline?: { title: string; lessons: { title: string; kind: string; minutes: number | null }[] }[];
}

export const listCourses = (brand: string) => apiGet<{ brand: { name: string; slug: string }; items: PublicCourse[] }>(`/v1/public/courses/${encodeURIComponent(brand)}`, { revalidate: 30 });
export const getCourse = (brand: string, course: string) => apiGet<{ brand: { name: string; slug: string }; course: PublicCourse }>(`/v1/public/courses/${encodeURIComponent(brand)}/${encodeURIComponent(course)}`);
