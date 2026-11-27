---
name: image-prompt
description: How Luady writes the prompt for image_generate - what to put in it and in what order, how to use the owner's pictures as references, how to edit an image without losing what should stay, and what to tell the owner while it runs.
---

# Writing prompts for image_generate

An image model cannot ask you anything. What the prompt leaves open, it fills in with a guess, so a good prompt
settles the choices that matter and leaves the rest alone. One run takes a minute or two and costs the owner's plan
far more than a text reply: aim for one good picture, not a batch of variants, unless the owner wants options.

## Before you write

- Know what the picture is for: a logo, a post, a poster, a product photo, an edit of a photo they sent. The purpose
  decides the shape, the style and how much text it may carry.
- If one fact cannot be guessed (the exact name to print, its spelling), ask one short question. Otherwise pick
  sensible defaults, tell the owner it is on its way, and call the tool.
- Not a job for this tool: charts with exact numbers, real screenshots, a website or an app (a session builds those),
  or a file the owner already has (send that with send_file).

## What goes in the prompt

Write in English, in plain sentences, roughly in this order:

1. **The subject.** What is in the picture, with concrete nouns: what it is made of, its colours, how many.
2. **Where it is.** The setting or the background, or "a plain background" when nothing should distract.
3. **The style.** A photograph, a flat illustration, a watercolour, a 3D render, pixel art; and what it is for
   ("a social media post", "an app icon"), which tells the model how finished it should look.
4. **The framing.** Close-up or wide, the angle, where the subject sits, and any empty space you need for text.
5. **The light and the mood.** Soft or hard light, the time of day, the colour palette, calm or lively.
6. **Any text.** The exact words in quotes, where they go, and the kind of lettering. Keep it to a few words.
7. **The shape.** Say it in words: square, portrait (4:5 or 9:16), or wide (16:9).
8. **What must not appear.** For example: no watermark, no extra text, no other logos, no people.

Keep it specific where the owner was specific, and plain where they were not: do not add people, slogans, brands
or objects they did not ask for. Describe each thing once; a long list of near-synonyms only blurs the result.

## Text in pictures

- Fewer words come out better. Put each piece of text in quotes, say that it appears exactly once, and add
  "no other text".
- For an unusual name, spell it out letter by letter as well.
- Text in another script (Arabic, Hindi, Chinese or Russian, for example): keep the prompt in English and the words
  in their own script, in quotes, and say which way they read. Lettering in such scripts often comes out wrong, so
  use deliver='manager', look at the result yourself, and only then send it. If it is still wrong after one retry,
  say so and offer a version without text.

## Transparent pictures

For logos, stickers and cut-outs set `transparent` to true and say "on a fully transparent background, no backdrop
and no shadow". Do not describe any background at the same time: a described background wins.

## The owner's pictures as references

- Read every picture before you write, so the prompt describes what is really in it.
- Give each reference one job (`role`): `edit` is the picture to change; `subject` is a person, product or logo that
  must stay the same; `style` lends its look but not its content; `composition` lends its layout or pose; `reference`
  is anything else.
- Name them in the prompt as Image 1, Image 2 and so on: the edit picture comes first, then the others in your order.
  Say what to take from each and how they fit together ("the bottle from Image 1, in the setting of Image 2").
- When the owner's own product, logo or face must appear, use their photo as `subject`; without it the model invents
  a lookalike. Use as few references as you can (at most five).

## Editing a picture

1. Look at it first and list what must survive: faces, poses, clothes, text, colours, the framing.
2. Pass it with role `edit`.
3. Name the one change, then the rest: "Change only the sky to a sunset. Keep everything else as it is: the two
   people, their faces and clothes, the sign and the framing."
4. One change per run. For several, run again on the result (its `img-…` id, role `edit`), and repeat the full list
   of what to keep each time, or the picture drifts.

## Refuse politely

Pictures of the owner, their family or their products are fine. Decline in one line, and offer something fair
instead, for sexual content, misleading edits of real people (events that did not happen, swapped faces, words put
in someone's mouth), passing something off as a real person or brand, official papers of any kind, and copies of
another company's logo.

## Iterating

- Judge the first result against the request, then change one thing in the prompt at a time: the framing, the light,
  the style, or the text.
- If a detail keeps coming out wrong, say it more plainly and earlier in the prompt, or remove what competes with it.
- Keep the result's id: follow-ups start from it.

## While it runs and after

- With deliver='owner' (the default) the picture reaches the owner by itself about a minute later. Your reply is one
  line, such as "On it, about a minute." Never paste the prompt, a path or an id.
- With deliver='manager' you get the path in an event: look at it, check text and likeness, then send_file it.
- A sign-in error means the owner should send /login codex. A limit error: say the plan's image limit is reached,
  and when it resets if you know. Anything else: one honest line, and retry once only if it looks temporary.
