# TODOS

## Design

### [ ] Visual mockup session with gstack designer
**What:** Generate 3 visual variants each for FileLoader screen and dashboard layout using the gstack design binary.
**Why:** The design review was text-only because `$D setup` (OpenAI API key) isn't configured. Visual mockups would make design decisions concrete and catch layout issues before they're baked in.
**Pros:** See actual rendered designs before committing to the current layout.
**Cons:** Requires OpenAI API key setup.
**Context:** Run `~/.claude/skills/gstack/design/dist/design setup` to configure, then re-run `/plan-design-review`.
**Depends on:** OpenAI API key