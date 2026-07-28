# Synthetic usability script

## Purpose

Verify that a template owner who understands the organization's Word document
but not the implementation can reach and interpret a rendered design review.
Use only `neutral-word-16.111.1.docx` and a disposable local project directory.

## Participant setup

- Give the participant the normal CLI help and the fixture.
- Do not explain internal identifiers, file formats, renderer internals, or
  implementation vocabulary.
- Record commands, elapsed time, requested assistance, and the participant's
  explanation of the final review.

## Tasks

1. Import the supplied Word document as a new PDF-template project.
2. Explain which design choices will change, which current choices are
   retained, which decisions remain open, and which Word features are
   unsupported.
3. Review the page graphic, choose whether to use it as a background, and
   confirm accessibility text and usage rights when including it.
4. Produce and open the rendered design review.

## Explicit success criteria

- The participant reaches a rendered design review with at most four primary
  commands: `import`, `review`, `preview`, plus at most one `status` command.
- All four tasks are completed without candidate IDs, capability paths,
  editing structured data, naming the built-in baseline, or knowledge of
  document-package or rendering internals.
- The participant correctly identifies, in their own words:
  - what has been applied;
  - what current design choices were retained;
  - what remains open;
  - what is unsupported.
- The asset choice records an explicit role or exclusion, accessibility-text
  decision, and rights confirmation.
- The observer records task success, assistance count, total elapsed time,
  time to first rendered review, command count, and the four comprehension
  results separately.

A run fails if a rendered review takes more than four primary commands, if an
open or unsupported item is mistaken for an applied choice, or if the
participant must use an internal identifier to continue.
