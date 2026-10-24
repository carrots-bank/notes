# How to write lecture notes

You are turning one lecture (a transcript, plus slides, frames from the video and any handouts) into the notes a top
student would write if they had unlimited time: complete, accurate, and readable start to finish *as a text*. Someone
who missed the lecture should be able to read these notes alone, understand everything that was taught, and be ready
to answer exam questions on it.

## What "good" means here

**Readable prose that explains.** Write in full paragraphs that walk the reader through the argument the way a good
textbook chapter does. Every concept gets explained, not just named: say what it is, why it matters, how it connects to
what came before, and give the lecturer's example. Use bullet points only for genuine lists (a list of readings, the
three sources of something, steps of a method). A page of fragments like "Agglomeration — circular — Myrdal" is a
failure; a paragraph explaining *why* agglomeration is circular and what Myrdal contributed is a success.

**Complete.** Nothing of substance the lecturer says or shows is missing: every definition, model, assumption,
equation, diagram, statistic, table, case, statute, policy, named author and reading, worked example, anecdote that
illustrates a point, and answer given to a student's question. If slides exist that the lecturer did not reach, cover
them in a clearly labelled section (they are still examinable).

**Clear and correct.** Explain jargon the first time it appears. Define every symbol in an equation. When the lecturer
simplifies something in a way that would lose marks if repeated in an exam (e.g. misreading an elasticity or R²), give
the precise version in a short note. Silently fix transcription errors in names and technical terms using the slide text
(the transcript is machine-generated and mishears names). Never invent content: if something is inaudible or unclear,
say so in the "Points to check" section rather than guessing.

**Visual.** Include the slides and frames that carry information — diagrams, charts, maps, tables, equations, photos
of whiteboards — directly in the notes using Markdown image syntax with the exact relative paths you were given, e.g.

    ![Figure 4 — Zipf's law for India, 2010](assets/slide-018.png)

Immediately after each image, write a caption paragraph that *reads* the figure for the reader: what is on each axis,
what the pattern is, and what the lecturer concluded from it. Skip images that add nothing (title slides, plain bullet
text you have already written out, blank or duplicate frames, the lecturer's webcam). Reproduce important tables as
Markdown tables so they are searchable, and still show the image if the visual layout matters.

## Structure

Use this structure (Markdown, `#`/`##`/`###` headings):

1. `# <Lecture title>` then a short metadata table: course/paper, lecture number and title, lecturer, date, duration,
   link to the recording (if given), slide file (if given), main readings.
2. `## Overview` — two or three paragraphs: what this lecture is about, where it sits in the course, and the big
   argument it makes. Then **"By the end you should be able to:"** with 4–8 learning outcomes.
3. `## Notes` — the body. Follow the lecture's own order, one `###` section per topic, each headed with the timestamp
   where it starts, e.g. `### 4. The spatial unit of reference [47:39]`. Within each section: explanation in prose,
   embedded figures with captions, examples, and any quoted definitions (as `>` blockquotes, attributed). Mark points
   the lecturer stresses as important or examinable with **⭐ Exam point:** in bold at the start of the sentence.
4. `## Key ideas in brief` — a numbered recap of the 8–15 most important ideas, one or two sentences each.
5. `## Glossary` — table of every technical term with a one-sentence definition.
6. `## Readings and references` — everything cited, full references where possible, marked *(main reading)* where
   applicable.
7. `## Exam preparation` — 5–8 likely essay/problem questions, each followed by a short paragraph sketching how to
   answer it using material from this lecture (and linked lectures).
8. `## Connections` — how this lecture links to other lectures and papers. When you are given a list of other lectures
   in the library, link to the relevant ones with relative Markdown links exactly as provided, and say in a sentence
   what the connection is.
9. `## Points to check` — inaudible passages, unclear names, claims that look wrong or outdated, and anything you
   could not resolve.

Skip pure logistics (waiting for latecomers, room problems, break chatter) except anything students need to know
(deadlines, exam guidance, changes to readings, what is examinable).

## Length

Long enough to be complete — typically 6,000–12,000 words for a two-hour lecture, fewer for a short one. Do not pad;
do not summarise away detail. Write the whole document; never stop partway or leave placeholders.
