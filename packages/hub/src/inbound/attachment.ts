import type { MediaRef } from '@luady/shared';

/** A voice note as the add-on reports it: the add-on transcribes; the hub never does. */
export type VoiceNote = NonNullable<NonNullable<IncomingMedia['voice']>>;
export type IncomingMedia = MediaRef & { voice?: { transcript: string | null; error: string | null } };

function sizeLabel(bytes: number | null): string | null {
  if (bytes === null) return null;
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function details(media: MediaRef): string {
  return [media.mime, sizeLabel(media.size)].filter((part): part is string => part !== null && part !== '').join(', ');
}

const named = (media: MediaRef): string => (media.fileName === null ? media.kind : `${media.kind} "${media.fileName}"`);

/** The line the manager sees for a file the owner sent; the caption (if any) comes first. */
export function describeAttachment(media: MediaRef): string {
  const what = `${named(media)} (${details(media)})`;
  if (media.path === null) return `[The owner sent a ${what} but it could not be saved: ${media.error ?? 'unknown error'}]`;
  return `[Attached ${what}: ${media.path}]`;
}

export const QUOTED_IMAGE_MISSING = '(the replied-to picture could not be downloaded — ask the owner to resend it)';

/** The picture (or file) in the message the owner replied to, as a line for the manager (an image_generate reference). */
export function describeQuotedMedia(media: MediaRef): string {
  const picture = media.kind === 'image' || media.kind === 'sticker';
  if (media.path === null) return picture ? QUOTED_IMAGE_MISSING : `(the replied-to ${media.kind} could not be downloaded)`;
  return `[Replied-to ${named(media).replace(/^sticker/, 'image')} (${details(media)}): ${media.path}]`;
}

/** What the manager reads for a voice note the add-on transcribed: the words first, then the file line. */
export function voiceNoteText(voice: VoiceNote, media: MediaRef): string {
  if (voice.transcript === null) {
    return `${describeAttachment(media)}\n(Transcription failed: ${voice.error ?? 'unknown error'})`;
  }
  const words = voice.transcript.trim();
  const head = words === '' ? '🎤 Voice note: no speech could be heard.' : `🎤 Voice note (transcribed): ${words}`;
  return `${head}\n${describeAttachment(media)}`;
}

export function textWithAttachment(caption: string, media: MediaRef): string {
  const line = describeAttachment(media);
  return caption.trim() === '' ? line : `${caption.trim()}\n${line}`;
}
