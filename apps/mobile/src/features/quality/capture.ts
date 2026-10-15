import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';

export interface Picked { base64: string; mime: string; name: string }

/** Takes a photo with the camera (or picks one when the camera isn't available or allowed), scaled down for upload. */
export async function takePhoto(fromLibrary = false): Promise<Picked | null> {
  let library = fromLibrary || Platform.OS === 'web';
  if (!library) {
    const perm = await ImagePicker.requestCameraPermissionsAsync().catch(() => null);
    if (!perm?.granted) library = true;
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], base64: true, quality: 0.5, exif: false };
  const r = library ? await ImagePicker.launchImageLibraryAsync(opts) : await ImagePicker.launchCameraAsync(opts);
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0]!;
  const base64 = a.base64 ?? (a.uri.startsWith('data:') ? a.uri.split(',')[1] ?? '' : '');
  if (!base64) return null;
  const mime = a.mimeType ?? (a.uri.startsWith('data:') ? a.uri.slice(5, a.uri.indexOf(';')) : 'image/jpeg');
  return { base64, mime, name: a.fileName ?? `photo-${Date.now()}.jpg` };
}

/** Picks a PDF or an image from the phone (compliance documents). */
export async function pickDocument(): Promise<Picked | null> {
  if (Platform.OS === 'web') return takePhoto(true);
  const r = await File.pickFileAsync({ mimeTypes: ['application/pdf', 'image/*'] }).catch(() => null);
  if (!r || r.canceled || !r.result) return null;
  const file = r.result;
  const base64 = await file.base64();
  const name = file.name;
  const mime = file.type || (name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  return { base64, mime, name };
}
