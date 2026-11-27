import type { ImageReference } from '../core/contracts.js';

type Role = ImageReference['role'];

const ROLE_TEXT: Readonly<Record<Role, string>> = {
  edit: 'base image to edit: change only what is asked above; keep everything else exactly as it is (faces and identity, pose, composition, text, colours, background).',
  style: 'style reference: match its art style, colour palette, lighting and texture; do not copy its subject or layout.',
  subject: 'subject reference: keep this person/product/logo exactly recognisable (same face, shape, colours, details).',
  composition: 'composition reference: follow its layout, framing, camera angle and pose.',
  reference: 'reference: use it as described above.',
};

/** The edit endpoint gets the images in this order: every `edit` image first, then the rest, each group as given. */
export function orderReferences<T extends { role: Role }>(refs: readonly T[]): T[] {
  return [...refs.filter((ref) => ref.role === 'edit'), ...refs.filter((ref) => ref.role !== 'edit')];
}

/** Names every image by its position so GPT Image knows what each one is for. Empty without references. */
export function referenceLegend(refs: readonly Pick<ImageReference, 'role' | 'note'>[]): string {
  if (refs.length === 0) return '';
  const lines = refs.map((ref, index) => {
    const note = ref.note.trim().replace(/\s+/g, ' ');
    return `Image ${index + 1} — ${ROLE_TEXT[ref.role]}${note === '' ? '' : ` Note: ${note}`}`;
  });
  return ['Reference images, in the order provided:', ...lines].join('\n');
}

/** Luady's prompt, then (with references) a blank line and the legend. */
export function finalImagePrompt(prompt: string, refs: readonly Pick<ImageReference, 'role' | 'note'>[]): string {
  const legend = referenceLegend(refs);
  return legend === '' ? prompt.trim() : `${prompt.trim()}\n\n${legend}`;
}

export interface InstructionInput {
  prompt: string;
  /** Absolute paths of the materialised references, already in final order. */
  refPaths: readonly string[];
  transparent: boolean;
}

/** The tag name around the prompt; inside the prompt it is written with a space, so the prompt cannot close its own tag. */
const PROMPT_TAG_RE = /image_prompt/gi;

/** What codex reads on stdin: one image_gen call with explicit arguments and the prompt copied verbatim. */
export function imageInstruction({ prompt: raw, refPaths, transparent }: InstructionInput): string {
  const prompt = raw.replace(PROMPT_TAG_RE, 'image prompt');
  return [
    'Call your image generation tool (image_gen) exactly once. Do not run shell commands, do not read or write files, '
      + 'do not ask questions, do not rewrite the prompt.',
    'Use exactly these arguments:',
    '- prompt: everything between <image_prompt> and </image_prompt>, copied character for character',
    ...(refPaths.length === 0 ? [] : [`- referenced_image_paths: ${JSON.stringify(refPaths)}`]),
    `- transparent_background: ${transparent}`,
    '<image_prompt>',
    prompt,
    '</image_prompt>',
    'When the image is saved, reply with just: done',
  ].join('\n');
}
